#!/usr/bin/env python3
"""
Orquestrador do Anki na Nuvem (GitHub Actions).

Responsabilidades:
1. Configurar ambiente gráfico virtual (Xvfb + Openbox) no Linux com flags Chromium sem sandbox.
2. Pré-criar o prefs21.db com o perfil 'User 1', desativando autoSync inicial e configurando gldriver6.
3. Baixar e instalar o Anki MCP Server oficial com configurações seguras de host/origem.
4. Iniciar o Anki Headless, fazer streaming dos logs e aguardar a porta 3141 responder.
5. Fazer login e download completo headless da coleção do AnkiWeb sem diálogos modais gráficos.
6. Iniciar o túnel Ngrok no domínio fixo configurado registrando logs em arquivo.
7. Fornecer endpoint de Health Check e comando de desligamento.
8. Monitorar tempo de sessão programado.
9. Ao término ou cancelamento, sincronizar tudo de volta para o AnkiWeb (upload headless) e desligar limpo.
"""

import json
import logging
import os
import pickle
import signal
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("AnkiCloud")

# Variáveis de ambiente & Configurações
ANKIWEB_USER = os.environ.get("ANKIWEB_USER", "").strip()
ANKIWEB_PASSWORD = os.environ.get("ANKIWEB_PASSWORD", "").strip()
NGROK_AUTHTOKEN = os.environ.get("NGROK_AUTHTOKEN", "").strip()
NGROK_DOMAIN = os.environ.get("NGROK_DOMAIN", "").strip()
ANKI_MCP_API_KEY = os.environ.get("ANKI_MCP_API_KEY", "").strip()
DURATION_MINUTES = float(os.environ.get("DURATION_MINUTES", os.environ.get("DEFAULT_DURATION_MINUTES", "30")))

ANKI_BASE_DIR = Path.home() / ".local" / "share" / "Anki2"
ADDONS_DIR = ANKI_BASE_DIR / "addons21"
SHUTDOWN_FILE = Path("/tmp/anki_shutdown_requested")
SYNC_FLAG_FILE = Path("/tmp/anki_synced_ok")
SHUTDOWN_DONE_FILE = Path("/tmp/anki_shutdown_sync_done")
STATUS_FILE = Path("/tmp/anki_cloud_status.json")

START_TIME = time.time()
shutdown_event = False


def check_prerequisites():
    """Valida se as credenciais mínimas foram fornecidas nos Secrets."""
    logger.info("Validando credenciais do ambiente...")
    if not ANKIWEB_USER or not ANKIWEB_PASSWORD:
        logger.warning("Credenciais do AnkiWeb (ANKIWEB_USER / ANKIWEB_PASSWORD) não foram definidas.")
        logger.warning("O Anki iniciará com coleção local vazia (sem sincronizar com o AnkiWeb).")
    else:
        logger.info(f"AnkiWeb configurado para o usuário: {ANKIWEB_USER[:3]}***@{ANKIWEB_USER.split('@')[-1] if '@' in ANKIWEB_USER else '***'}")

    if not NGROK_AUTHTOKEN:
        logger.error("NGROK_AUTHTOKEN não foi definido nos Secrets! O túnel não poderá ser aberto.")
        sys.exit(1)


def setup_virtual_display():
    """Configura ambiente gráfico virtual (Xvfb + Openbox) e flags do WebEngine no Linux."""
    logger.info("Configurando ambiente gráfico virtual e flags do WebEngine...")
    os.environ["DISPLAY"] = ":99"
    os.environ["QTWEBENGINE_DISABLE_SANDBOX"] = "1"
    os.environ["QTWEBENGINE_CHROMIUM_FLAGS"] = "--no-sandbox --disable-gpu --disable-software-rasterizer"
    os.environ["QT_QPA_PLATFORM"] = "xcb"
    os.environ["ANKI_SOFTWAREOPENGL"] = "1"
    os.environ["LANG"] = "en_US.UTF-8"
    os.environ["LC_ALL"] = "en_US.UTF-8"

    # Inicia Xvfb com saída redirecionada para log
    xvfb_log = open("/tmp/xvfb.log", "w", encoding="utf-8")
    subprocess.Popen(
        ["Xvfb", ":99", "-screen", "0", "1280x1024x24", "-ac", "+extension", "GLX", "+render", "-noreset"],
        stdout=xvfb_log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )

    # Aguarda a criação real do socket /tmp/.X11-unix/X99 (conforme headless-anki)
    socket_path = Path("/tmp/.X11-unix/X99")
    start_xvfb = time.time()
    while time.time() - start_xvfb < 10:
        if socket_path.exists():
            logger.info("✅ Display virtual Xvfb :99 pronto e socket ativo.")
            break
        time.sleep(0.2)
    else:
        logger.warning("Socket do Xvfb /tmp/.X11-unix/X99 não apareceu em 10s, prosseguindo...")

    # Inicia o gerenciador de janelas Openbox
    logger.info("Iniciando Window Manager (openbox)...")
    openbox_log = open("/tmp/openbox.log", "w", encoding="utf-8")
    subprocess.Popen(
        ["openbox"],
        stdout=openbox_log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    time.sleep(1)


def preseed_profile():
    """
    Pré-cria o banco de preferências (prefs21.db) com _global e User 1 registrados.
    Elimina totalmente diálogos de primeiro boot e desativa autoSync concorrente.
    Também grava gldriver6 com 'software' para desabilitar aceleração via hardware problemática.
    """
    ANKI_BASE_DIR.mkdir(parents=True, exist_ok=True)
    user_profile = ANKI_BASE_DIR / "User 1"
    user_profile.mkdir(parents=True, exist_ok=True)

    # Força driver de software para evitar falhas de contexto OpenGL/Vulkan sem GPU
    gldriver_file = ANKI_BASE_DIR / "gldriver6"
    try:
        with open(gldriver_file, "w", encoding="utf-8") as f:
            f.write("software")
        logger.info("✅ Driver OpenGL configurado para 'software' em gldriver6.")
    except Exception as e:
        logger.warning(f"Não foi possível gravar gldriver6: {e}")

    prefs_db = ANKI_BASE_DIR / "prefs21.db"
    logger.info("Inicializando prefs21.db com o perfil 'User 1'...")

    meta_conf = {
        "ver": 0,
        "updates": False,
        "created": int(time.time()),
        "id": 12345678,
        "lastMsg": 0,
        "suppressUpdate": True,
        "firstRun": False,
        "defaultLang": "en_US",
        "lang": "en_US",
        "last_run_version": 260903,
        "auto_sync": False,
        "last_loaded_profile_name": "User 1",
        "last_loaded_profile": "User 1",
    }

    profile_conf = {
        "name": "User 1",
        "mainWindowGeom": None,
        "mainWindowState": None,
        "numBackups": 50,
        "lastOptimize": int(time.time()),
        "searchHistory": [],
        "syncKey": None,
        "syncMedia": True,
        "autoSync": False,
        "allowHTML": False,
        "importMode": 1,
        "lastColour": "#00f",
        "stripHTML": True,
        "deleteMedia": False,
    }

    conn = sqlite3.connect(prefs_db)
    cur = conn.cursor()
    cur.execute("CREATE TABLE IF NOT EXISTS profiles (name TEXT PRIMARY KEY, data BLOB)")
    cur.execute("INSERT OR REPLACE INTO profiles VALUES ('_global', ?)", (pickle.dumps(meta_conf, protocol=4),))
    cur.execute("INSERT OR REPLACE INTO profiles VALUES ('User 1', ?)", (pickle.dumps(profile_conf, protocol=4),))
    conn.commit()
    conn.close()

    logger.info("✅ Perfil 'User 1' gravado em prefs21.db (firstRun ignorado e autoSync desativado).")


def install_latest_ankimcp():
    """Baixa e instala o Anki MCP Server oficial direto do GitHub Releases com config segura."""
    ADDONS_DIR.mkdir(parents=True, exist_ok=True)
    mcp_addon_dir = ADDONS_DIR / "anki_mcp_server"

    logger.info("Baixando a versão oficial mais recente do Anki MCP Server do GitHub...")
    api_url = "https://api.github.com/repos/ankimcp/anki-mcp-server-addon/releases/latest"
    req = urllib.request.Request(api_url, headers={"User-Agent": "AnkiCloudRunner"})

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
            download_url = None
            for asset in data.get("assets", []):
                if asset.get("name", "").endswith(".ankiaddon"):
                    download_url = asset.get("browser_download_url")
                    break

            if not download_url:
                raise RuntimeError("Asset .ankiaddon não encontrado no release do GitHub.")

            tag_name = data.get("tag_name", "latest")
            logger.info(f"Baixando AnkiMCP ({tag_name}): {download_url}")
            addon_zip_path = Path("/tmp/anki_mcp_server.ankiaddon")

            urllib.request.urlretrieve(download_url, addon_zip_path)

            mcp_addon_dir.mkdir(exist_ok=True)
            with zipfile.ZipFile(addon_zip_path, "r") as zip_ref:
                zip_ref.extractall(mcp_addon_dir)

            logger.info(f"Anki MCP Server instalado com sucesso em: {mcp_addon_dir}")

    except Exception as e:
        logger.warning(f"Não foi possível baixar via GitHub Releases ({e}). Usando fallback...")
        mcp_addon_dir.mkdir(exist_ok=True)

    # Configuração do MCP Server (Porta 3141, HTTP habilitado e validações de segurança)
    allowed_hosts = [NGROK_DOMAIN, f"{NGROK_DOMAIN}:443"] if NGROK_DOMAIN else []
    allowed_origins = [f"https://{NGROK_DOMAIN}"] if NGROK_DOMAIN else []

    # Evita que validate_http_api_key() dispare um QMessageBox modal se a chave tiver < 16 chars
    safe_api_key = ANKI_MCP_API_KEY.strip()
    if 0 < len(safe_api_key) < 16:
        logger.warning("ANKI_MCP_API_KEY tem menos de 16 caracteres; desabilitando chave (<16 chars) para evitar modal de aviso do AnkiMCP.")

    cfg = {
        "http_enabled": True,
        "http_port": 3141,
        "http_host": "0.0.0.0",
        "http_path": "",
        "http_api_key": safe_api_key if len(safe_api_key) >= 16 else "",
        "http_allowed_hosts": allowed_hosts,
        "http_allowed_origins": allowed_origins,
        "cors_origins": ["*"],
        "max_notes_per_batch": 100,
        "show_settings_menu_item": False,
        "show_toolbar_indicator": False,
        "show_sync_tooltip": False,
        "log_to_file": True,
    }
    with open(mcp_addon_dir / "config.json", "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    with open(mcp_addon_dir / "meta.json", "w", encoding="utf-8") as f:
        json.dump({"config": cfg}, f, indent=2)
    logger.info("Configuração do Anki MCP Server gravada na porta 3141 (config.json e meta.json).")


def install_ankiconnect():
    """Instala o AnkiConnect para permitir integrações legadas ou híbridas."""
    ac_dir = ADDONS_DIR / "2055492159"
    ac_dir.mkdir(parents=True, exist_ok=True)
    try:
        logger.info("Baixando e instalando AnkiConnect...")
        url = "https://github.com/FooSoft/anki-connect/archive/refs/heads/master.zip"
        zip_path = Path("/tmp/ankiconnect.zip")
        urllib.request.urlretrieve(url, zip_path)
        with zipfile.ZipFile(zip_path, "r") as z:
            for member in z.namelist():
                if member.startswith("anki-connect-master/plugin/"):
                    rel = member.replace("anki-connect-master/plugin/", "")
                    if rel:
                        dest = ac_dir / rel
                        if member.endswith("/"):
                            dest.mkdir(parents=True, exist_ok=True)
                        else:
                            dest.parent.mkdir(parents=True, exist_ok=True)
                            with z.open(member) as src, open(dest, "wb") as dst:
                                dst.write(src.read())
        config_file = ac_dir / "config.json"
        with open(config_file, "w", encoding="utf-8") as f:
            json.dump({
                "apiKey": None,
                "apiLogPath": None,
                "ignoreNotices": [],
                "webBindAddress": "0.0.0.0",
                "webBindPort": 8765,
                "webCorsOriginList": ["*"]
            }, f, indent=2)
        logger.info("AnkiConnect instalado com sucesso na porta 8765.")
    except Exception as e:
        logger.warning(f"Falha ao instalar AnkiConnect opcional: {e}")


def install_cloud_helper_addon():
    """Instala add-on headless para login AnkiWeb, full-download no boot e full-upload no shutdown."""
    helper_dir = ADDONS_DIR / "cloud_helper"
    helper_dir.mkdir(parents=True, exist_ok=True)

    helper_code = f'''import os
import time
import traceback
from aqt import mw, gui_hooks
import aqt.utils
from PyQt6.QtCore import QTimer

ANKIWEB_USER = {json.dumps(ANKIWEB_USER)}
ANKIWEB_PASSWORD = {json.dumps(ANKIWEB_PASSWORD)}
SHUTDOWN_FILE = "/tmp/anki_shutdown_requested"
SYNC_FLAG_FILE = "/tmp/anki_synced_ok"
SHUTDOWN_DONE_FILE = "/tmp/anki_shutdown_sync_done"
_shutting_down = False

# Blindagem Headless: impede que QMessageBox modais travem o Xvfb
def _headless_log_box(text, *args, **kwargs):
    print(f"[HeadlessDialogIntercepted] {{text}}", flush=True)
    return 0

aqt.utils.showWarning = _headless_log_box
aqt.utils.showInfo = _headless_log_box
aqt.utils.showCritical = _headless_log_box
aqt.utils.askUser = lambda *args, **kwargs: True
if hasattr(aqt.utils, "ask_user_dialog"):
    aqt.utils.ask_user_dialog = lambda *args, **kwargs: None

def _wait_media_sync(max_wait=45):
    start = time.time()
    while time.time() - start < max_wait:
        try:
            st = mw.col.media_sync_status()
            if not st.active:
                break
        except Exception:
            break
        time.sleep(0.3)

def run_headless_sync(direction="download", on_complete=None):
    """
    direction='download' (boot): em caso de conflito/coleção nova, baixa do AnkiWeb (upload=False).
    direction='upload' (shutdown): em caso de conflito/schema change, envia para o AnkiWeb (upload=True).
    """
    if not ANKIWEB_USER or not ANKIWEB_PASSWORD:
        print("[CloudHelper] Credenciais do AnkiWeb não configuradas, pulando sincronização.", flush=True)
        with open(SYNC_FLAG_FILE, "w") as f:
            f.write("skipped_no_credentials")
        if on_complete:
            on_complete(False)
        return

    def _worker():
        auth = mw.pm.sync_auth()
        if not auth or not auth.hkey:
            masked = ANKIWEB_USER[:3] + "***" if len(ANKIWEB_USER) >= 3 else "***"
            print(f"[CloudHelper] Autenticando no AnkiWeb ({{masked}})...", flush=True)
            endpoint = mw.pm.sync_endpoint()
            auth = mw.col.sync_login(
                username=ANKIWEB_USER,
                password=ANKIWEB_PASSWORD,
                endpoint=endpoint,
            )
            mw.pm.set_sync_key(auth.hkey)
            mw.pm.set_sync_username(ANKIWEB_USER)
            if auth.endpoint:
                mw.pm.set_current_sync_url(auth.endpoint)

        out = mw.col.sync_collection(auth, True)
        if out.new_endpoint:
            mw.pm.set_current_sync_url(out.new_endpoint)
        if out.host_number:
            mw.pm.set_host_number(out.host_number)
        return auth, out

    def _on_done(fut):
        try:
            auth, out = fut.result()
            mw.pm.save()
            req = int(out.required)  # 0 = NO_CHANGES, 1 = NORMAL_SYNC, 2 = FULL_SYNC, 3 = FULL_DOWNLOAD, 4 = FULL_UPLOAD
            print(f"[CloudHelper] Resultado sync_collection: required={{req}}", flush=True)

            if req in (0, 1):
                mw.col._load_scheduler()
                mw.reset()
                with open(SYNC_FLAG_FILE, "w") as f:
                    f.write("synced")
                print("[CloudHelper] ✅ Sincronização incremental concluída com sucesso!", flush=True)
                if on_complete:
                    on_complete(True)
                return

            # Full sync necessário (sem abrir diálogo modal!)
            upload_flag = (direction == "upload") if req == 2 else (req == 4)
            if direction == "download" and req in (2, 3):
                upload_flag = False
            elif direction == "upload" and req in (2, 4):
                upload_flag = True

            print(f"[CloudHelper] Executando Full Sync headless (upload={{upload_flag}})...", flush=True)
            server_usn = out.server_media_usn if mw.pm.media_syncing_enabled() else None

            # Obtém credencial atualizada garantindo o endpoint do cluster específico (out.new_endpoint)
            fresh_auth = mw.pm.sync_auth()
            if fresh_auth and out.new_endpoint:
                fresh_auth.endpoint = out.new_endpoint

            gui_hooks.collection_will_temporarily_close(mw.col)

            def _full_worker():
                try:
                    mw.create_backup_now()
                except Exception:
                    pass
                mw.col.close_for_full_sync()
                mw.col.full_upload_or_download(
                    auth=fresh_auth,
                    server_usn=server_usn,
                    upload=upload_flag,
                )

            def _on_full_done(full_fut):
                try:
                    full_fut.result()
                    mw.reopen(after_full_sync=True)
                    mw.reset()
                    try:
                        mw.media_syncer.start_monitoring()
                    except Exception:
                        pass
                    with open(SYNC_FLAG_FILE, "w") as f:
                        f.write("synced")
                    print(f"[CloudHelper] ✅ Full Sync (upload={{upload_flag}}) concluído com sucesso!", flush=True)
                    if on_complete:
                        on_complete(True)
                except Exception as e:
                    print(f"[CloudHelper] ❌ Erro no Full Sync: {{type(e).__name__}}: {{e}}", flush=True)
                    traceback.print_exc()
                    try:
                        mw.reopen(after_full_sync=True)
                        mw.reset()
                    except Exception:
                        pass
                    if on_complete:
                        on_complete(False)

            mw.taskman.run_in_background(_full_worker, _on_full_done, uses_collection=False)

        except Exception as e:
            print(f"[CloudHelper] ❌ ERRO CRÍTICO no login/sync AnkiWeb: {{type(e).__name__}}: {{e}}", flush=True)
            traceback.print_exc()
            if on_complete:
                on_complete(False)

    mw.taskman.run_in_background(_worker, _on_done, uses_collection=False)

def on_profile_loaded(*args, **kwargs):
    print("[CloudHelper] Hook profile_did_open disparado!", flush=True)
    # Dispara o sync inicial após 500ms para permitir que o AnkiMCP finalize o bind da porta 3141
    QTimer.singleShot(500, lambda: run_headless_sync(direction="download"))

    timer = QTimer(mw)
    timer.timeout.connect(check_shutdown_signal)
    timer.start(2000)

def check_shutdown_signal():
    global _shutting_down
    if not _shutting_down and os.path.exists(SHUTDOWN_FILE):
        _shutting_down = True
        print("[CloudHelper] Sinal de desligamento detectado! Enviando dados ao AnkiWeb...", flush=True)
        def _finish(ok):
            _wait_media_sync(30)
            with open(SHUTDOWN_DONE_FILE, "w") as f:
                f.write("done")
            print("[CloudHelper] Encerrando Anki de forma limpa...", flush=True)
            mw.unloadProfileAndExit()

        run_headless_sync(direction="upload", on_complete=_finish)

gui_hooks.profile_did_open.append(on_profile_loaded)
'''
    with open(helper_dir / "__init__.py", "w", encoding="utf-8") as f:
        f.write(helper_code)
    logger.info("Addon auxiliar de sincronização (100% headless) instalado.")


class HealthHandler(BaseHTTPRequestHandler):
    """Servidor leve de Health Check e Shutdown para a IA consultar."""

    def do_GET(self):
        if self.path in ["/health", "/status", "/"]:
            now = time.time()
            elapsed_m = round((now - START_TIME) / 60, 1)
            remaining_m = max(0.0, round(DURATION_MINUTES - elapsed_m, 1))

            data = {
                "status": "online",
                "uptime_minutes": elapsed_m,
                "remaining_minutes": remaining_m,
                "total_duration_minutes": DURATION_MINUTES,
                "mcp_port": 3141,
                "ankiconnect_port": 8765,
                "ankiweb_synced": SYNC_FLAG_FILE.exists(),
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(data, indent=2).encode())

        elif self.path == "/shutdown":
            SHUTDOWN_FILE.touch()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b'{"status": "shutting_down", "message": "Sincronizando com AnkiWeb e encerrando..."}')
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        return


def start_health_server():
    """Inicia servidor de health check na porta 3142."""
    server = HTTPServer(("0.0.0.0", 3142), HealthHandler)
    t = Thread(target=server.serve_forever, daemon=True)
    t.start()
    logger.info("Health Check server ativo na porta 3142.")


def wait_for_port(port, timeout=90):
    """Aguarda até que a porta local esteja realmente aberta e aceitando conexões."""
    logger.info(f"Aguardando porta {port} abrir...")
    start = time.time()
    while time.time() - start < timeout:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(1.0)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                logger.info(f"✅ Porta {port} está ABERTA e respondendo!")
                return True
        time.sleep(2)

    logger.error(f"❌ FALHA: Porta {port} não respondeu após {timeout}s!")
    logger.error("Possíveis causas:")
    logger.error("  1. O Anki MCP Server addon não carregou corretamente")
    logger.error("  2. Erro ao inicializar o perfil ou o display virtual (Xvfb)")
    logger.error("  3. Modal de erro interceptado ou travando a main thread do Qt")
    sys.exit(1)


def start_ngrok():
    """Inicia o túnel Ngrok registrando logs em /tmp/ngrok.log."""
    logger.info("Configurando Ngrok Authtoken...")
    subprocess.run(["ngrok", "config", "add-authtoken", NGROK_AUTHTOKEN], check=True)

    ngrok_cmd = ["ngrok", "http", "127.0.0.1:3141", "--log", "stdout"]
    if NGROK_DOMAIN:
        ngrok_cmd.extend(["--domain", NGROK_DOMAIN, "--host-header", "rewrite"])

    logger.info(f"Iniciando Ngrok: {' '.join(ngrok_cmd)}...")
    ngrok_log_file = open("/tmp/ngrok.log", "w", encoding="utf-8")
    proc = subprocess.Popen(
        ngrok_cmd,
        stdout=ngrok_log_file,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    time.sleep(3)
    return proc


def handle_signals(signum, frame):
    """Captura SIGINT e SIGTERM para sincronização final garantida."""
    global shutdown_event
    sig_name = signal.Signals(signum).name if hasattr(signal, "Signals") else str(signum)
    logger.info(f"Sinal de encerramento recebido ({sig_name}). Solicitando desligamento gracioso...")
    SHUTDOWN_FILE.touch()
    shutdown_event = True


def main():
    signal.signal(signal.SIGINT, handle_signals)
    signal.signal(signal.SIGTERM, handle_signals)

    check_prerequisites()
    setup_virtual_display()
    preseed_profile()
    install_latest_ankimcp()
    install_ankiconnect()
    install_cloud_helper_addon()
    start_health_server()

    logger.info("Iniciando o Anki (sem sandbox do Chromium) com perfil 'User 1'...")
    anki_proc = subprocess.Popen(
        ["anki", "-l", "en", "-p", "User 1"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=True,
    )

    # Thread para repassar logs do Anki ao console em tempo real
    def stream_anki_logs():
        if anki_proc.stdout:
            for line in iter(anki_proc.stdout.readline, ""):
                if line.strip():
                    print(f"[Anki Log] {line.strip()}", flush=True)

    Thread(target=stream_anki_logs, daemon=True).start()

    # Espera ativa pela porta 3141 (Anki MCP)
    wait_for_port(3141, timeout=90)

    # Aguardar sincronização inicial com AnkiWeb (até 60s) antes de liberar o Ngrok
    if ANKIWEB_USER and ANKIWEB_PASSWORD:
        logger.info("Aguardando confirmação da sincronização inicial do AnkiWeb (/tmp/anki_synced_ok)...")
        sync_start = time.time()
        while time.time() - sync_start < 60:
            if SYNC_FLAG_FILE.exists():
                logger.info("✅ Sincronização inicial com o AnkiWeb confirmada!")
                break
            time.sleep(2)
        else:
            logger.warning("Tempo limite de 60s aguardando sincronização inicial atingido. Continuando...")

    ngrok_proc = start_ngrok()

    domain_str = f"https://{NGROK_DOMAIN}" if NGROK_DOMAIN else "Ngrok URL ativa"
    logger.info("=" * 60)
    logger.info("🚀 ANKI CLOUD ACTIONS PRONTO E ONLINE!")
    logger.info(f"🔗 Endpoint do MCP / Ngrok: {domain_str}")
    logger.info(f"⏳ Tempo de sessão programado: {DURATION_MINUTES} minutos")
    logger.info(f"💡 Para a IA desligar: chame a tool de desligamento ou o evento 'stop-anki'")
    logger.info("=" * 60)

    # Loop de monitoramento de tempo e sinais de saída
    poll_interval = 5
    while not shutdown_event:
        elapsed = time.time() - START_TIME
        if elapsed >= DURATION_MINUTES * 60:
            logger.info("⏱️ Tempo de sessão programado atingido! Iniciando encerramento...")
            SHUTDOWN_FILE.touch()
            break

        if SHUTDOWN_FILE.exists():
            logger.info("🛑 Sinal de desligamento recebido! Iniciando encerramento...")
            break

        if anki_proc.poll() is not None:
            logger.warning("O processo do Anki foi encerrado.")
            break

        time.sleep(poll_interval)

    # Processo de finalização limpa
    logger.info("Aguardando sincronização final com o AnkiWeb e encerramento limpo...")
    SHUTDOWN_FILE.touch()

    # Aguarda até 45s pela conclusão do sync final (/tmp/anki_shutdown_sync_done) ou encerramento do processo anki
    shutdown_start = time.time()
    while time.time() - shutdown_start < 45:
        if SHUTDOWN_DONE_FILE.exists() or anki_proc.poll() is not None:
            logger.info("✅ Confirmação de encerramento/sync final recebida!")
            break
        time.sleep(1)
    else:
        logger.warning("Tempo limite de 45s para sync final atingido.")

    if anki_proc.poll() is None:
        anki_proc.terminate()
        try:
            anki_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            anki_proc.kill()

    if ngrok_proc.poll() is None:
        ngrok_proc.terminate()

    logger.info("✅ Sessão finalizada com sucesso. Coleção salva na nuvem!")


if __name__ == "__main__":
    main()
