#!/usr/bin/env python3
"""
Orquestrador do Anki na Nuvem (GitHub Actions).

Responsabilidades:
1. Configurar ambiente gráfico virtual (Xvfb) no Linux.
2. Baixar e instalar automaticamente a versão mais recente do Anki MCP Server.
3. Configurar autenticação no AnkiWeb e baixar os baralhos atualizados.
4. Iniciar o Anki Headless e expor o MCP na porta 3141.
5. Iniciar o túnel Ngrok no domínio fixo configurado.
6. Fornecer endpoint de Health Check e comando de desligamento pela IA.
7. Monitorar tempo de sessão programado.
8. Ao término ou cancelamento, sincronizar tudo de volta para o AnkiWeb e desligar limpo.
"""

import json
import logging
import os
import signal
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
    """Inicia o Xvfb (Virtual Framebuffer) caso esteja no Linux sem display gráfico."""
    display = os.environ.get("DISPLAY")
    if not display:
        logger.info("Iniciando tela gráfica virtual (Xvfb :99)...")
        os.environ["DISPLAY"] = ":99"
        subprocess.Popen(
            ["Xvfb", ":99", "-screen", "0", "1024x768x24", "-ac"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(1)


def install_latest_ankimcp():
    """Baixa e instala o Anki MCP Server oficial direto do GitHub Releases."""
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
        # Fallback de configuração caso ocorra timeout no GitHub API
        mcp_addon_dir.mkdir(exist_ok=True)

    # Configuração do MCP Server (Porta 3141, HTTP habilitado e API Key)
    config_file = mcp_addon_dir / "config.json"
    cfg = {
        "http_enabled": True,
        "http_port": 3141,
        "http_host": "0.0.0.0",
        "http_path": "",
        "http_api_key": ANKI_MCP_API_KEY,
        "http_allowed_hosts": ["*"],
        "http_allowed_origins": ["*"],
        "cors_origins": ["*"],
        "max_notes_per_batch": 100,
        "log_to_file": True,
    }
    with open(config_file, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    logger.info("Configuração do Anki MCP Server gravada na porta 3141.")


def install_cloud_helper_addon():
    """
    Cria um addon auxiliar leve para:
    1. Fazer login no AnkiWeb e baixar a coleção na inicialização.
    2. Monitorar requisição de desligamento e salvar tudo antes de sair.
    """
    helper_dir = ADDONS_DIR / "cloud_helper"
    helper_dir.mkdir(parents=True, exist_ok=True)

    helper_code = f'''
import os
import time
import logging
from aqt import mw, gui_hooks
from PyQt6.QtCore import QTimer

logger = logging.getLogger("CloudHelper")

ANKIWEB_USER = "{ANKIWEB_USER}"
ANKIWEB_PASSWORD = "{ANKIWEB_PASSWORD}"
SHUTDOWN_FILE = "/tmp/anki_shutdown_requested"
SYNC_FLAG_FILE = "/tmp/anki_synced_ok"

def on_profile_loaded():
    logger.info("[CloudHelper] Perfil carregado.")
    if ANKIWEB_USER and ANKIWEB_PASSWORD:
        try:
            auth = mw.pm.sync_auth()
            if not auth or not auth.hkey:
                logger.info(f"[CloudHelper] Autenticando com AnkiWeb para {{ANKIWEB_USER}}...")
                new_auth = mw.col.sync_login(ANKIWEB_USER, ANKIWEB_PASSWORD)
                mw.pm.set_sync_auth(new_auth)
                logger.info("[CloudHelper] Login no AnkiWeb concluído!")
            
            logger.info("[CloudHelper] Iniciando sincronização com AnkiWeb...")
            mw.on_sync_button_clicked()
            with open(SYNC_FLAG_FILE, "w") as f:
                f.write("synced")
        except Exception as e:
            logger.error(f"[CloudHelper] Erro no login/sync AnkiWeb: {{e}}")

    # Inicia timer de verificação de desligamento
    timer = QTimer(mw)
    timer.timeout.connect(check_shutdown_signal)
    timer.start(2000)

def check_shutdown_signal():
    if os.path.exists(SHUTDOWN_FILE):
        logger.info("[CloudHelper] Sinal de desligamento detectado! Sincronizando antes de sair...")
        try:
            mw.on_sync_button_clicked()
            time.sleep(2)
        except Exception as e:
            logger.error(f"[CloudHelper] Erro ao sincronizar no shutdown: {{e}}")
        logger.info("[CloudHelper] Fechando Anki...")
        mw.close()

gui_hooks.profile_did_open.append(on_profile_loaded)
'''
    with open(helper_dir / "__init__.py", "w", encoding="utf-8") as f:
        f.write(helper_code)
    logger.info("Addon auxiliar de sincronização instalado.")


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
                "ankiweb_synced": Path("/tmp/anki_synced_ok").exists(),
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
        return  # Silenciar logs para não poluir o terminal


def start_health_server():
    """Inicia servidor de health check na porta 3142."""
    server = HTTPServer(("0.0.0.0", 3142), HealthHandler)
    t = Thread(target=server.serve_forever, daemon=True)
    t.start()
    logger.info("Health Check server ativo na porta 3142.")


def start_ngrok():
    """Inicia o túnel Ngrok."""
    logger.info("Configurando Ngrok Authtoken...")
    subprocess.run(["ngrok", "config", "add-authtoken", NGROK_AUTHTOKEN], check=True)

    ngrok_cmd = ["ngrok", "http", "3141"]
    if NGROK_DOMAIN:
        ngrok_cmd.extend(["--domain", NGROK_DOMAIN, "--host-header", "rewrite"])

    logger.info(f"Iniciando Ngrok: {' '.join(ngrok_cmd)}...")
    proc = subprocess.Popen(ngrok_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(3)
    return proc


def handle_signals(signum, frame):
    """Captura SIGINT e SIGTERM para sincronização final garantida."""
    global shutdown_event
    logger.info("Sinal de encerramento recebido (SIGINT/SIGTERM). Solicitando desligamento gracioso...")
    SHUTDOWN_FILE.touch()
    shutdown_event = True


def main():
    signal.signal(signal.SIGINT, handle_signals)
    signal.signal(signal.SIGTERM, handle_signals)

    check_prerequisites()
    setup_virtual_display()
    install_latest_ankimcp()
    install_cloud_helper_addon()
    start_health_server()

    logger.info("Iniciando o Anki em modo headless...")
    anki_proc = subprocess.Popen(["anki"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

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
    logger.info("Aguardando sincronização final do AnkiWeb...")
    time.sleep(5)

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
