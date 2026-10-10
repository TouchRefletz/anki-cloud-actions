# 🧠 Anki Cloud Actions

> **Rode o Anki com AnkiMCP na nuvem sob demanda via GitHub Actions, com sincronização automática do AnkiWeb e controle total por Inteligências Artificiais (Gemini Spark, Claude, Composio).**

[![Anki Cloud Server](https://github.com/TouchRefletz/anki-cloud-actions/actions/workflows/anki-server.yml/badge.svg)](https://github.com/TouchRefletz/anki-cloud-actions/actions/workflows/anki-server.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP Protocol](https://img.shields.io/badge/MCP-Supported-purple.svg)](https://modelcontextprotocol.io)

---

## 🎯 Visão Geral

O **Anki Cloud Actions** permite que você acesse e controle sua coleção completa de flashcards do **Anki de qualquer lugar do mundo**, sem precisar deixar o seu computador físico ligado.

Tudo roda em máquinas virtuais Linux (Ubuntu) no **GitHub Actions**:
1. Uma IA (como o **Gemini Spark** via Composio) ou você envia um comando de ativação.
2. O GitHub Actions inicializa o Anki com tela virtual (`Xvfb`).
3. Baixa e instala a versão oficial mais recente do **Anki MCP Server**.
4. Faz login na sua conta do **AnkiWeb** e baixa a versão mais atualizada dos seus baralhos.
5. Abre um túnel seguro via **Ngrok** com o seu domínio estático fixo.
6. A IA interage diretamente com o Anki (cria notas, organiza tags, faz revisões espaçadas).
7. Ao término da sessão (ou sob comando da IA), **sincroniza todas as alterações de volta para o AnkiWeb** e encerra o runner.

---

## 🛡️ Segurança em Repositórios Públicos (Zero Leak)

O repositório foi projetado para ser **100% público** (aproveitando os minutos gratuitos do GitHub Actions) com **blindagem total de dados**:
* **Nenhuma credencial ou dado pessoal fica salvo no código.**
* Arquivos `.env`, bancos de dados `.anki2`, mídias e logs locais são bloqueados pelo `.gitignore`.
* Todas as senhas e tokens ficam salvos exclusivamente nos **GitHub Actions Secrets**.

---

## 🚀 Como Configurar (Passo a Passo)

### 1. Crie o Repositório no GitHub
Envie esta pasta para a sua conta no GitHub (por exemplo: `TouchRefletz/anki-cloud-actions`).

```bash
git init
git add .
git commit -m "feat: initial anki cloud actions setup"
git branch -M main
git remote add origin https://github.com/TouchRefletz/anki-cloud-actions.git
git push -u origin main
```

### 2. Cadastre os Secrets no Repositório
No seu repositório no GitHub, acesse:
**Settings** ➔ **Secrets and variables** ➔ **Actions** ➔ **New repository secret**

Cadastre os seguintes 5 segredos:

| Nome do Secret | Descrição | Exemplo |
| :--- | :--- | :--- |
| `ANKIWEB_USER` | Seu e-mail de login no AnkiWeb | `seu_email@gmail.com` |
| `ANKIWEB_PASSWORD` | Sua senha da conta AnkiWeb | `sua_senha_secreta` |
| `NGROK_AUTHTOKEN` | Seu token de autenticação do Ngrok | `2abC...` |
| `NGROK_DOMAIN` | Seu domínio estático gratuito no Ngrok | `seu-dominio.ngrok-free.dev` |
| `ANKI_MCP_API_KEY` | *(Opcional)* Chave para proteger o endpoint MCP | `qualquer_chave_secreta` |

---

## 🤖 Como Conectar com o Gemini Spark (Composio)

Como o seu Gemini Spark já possui a integração do **GitHub via Composio**, você pode controlá-lo diretamente pelo chat:

### 1. Para Ligar o Anki
Basta dizer à IA:
> *"Ligue o meu servidor do Anki por 30 minutos."*

A IA executará a ferramenta `repository_dispatch` com:
* **Repositório:** `TouchRefletz/anki-cloud-actions` *(substitua pelo nome do seu repo)*
* **`event_type`:** `start-anki`
* **`client_payload`:**
  ```json
  {
    "duration_minutes": 30
  }
  ```

### 2. Para Consultar o Status Online
A IA ou você pode consultar a qualquer momento:
* **Endpoint HTTP:** `GET https://SEU_DOMINIO_NGROK/health`
  ```json
  {
    "status": "online",
    "uptime_minutes": 5.2,
    "remaining_minutes": 24.8,
    "total_duration_minutes": 30,
    "ankiweb_synced": true
  }
  ```

### 3. Para Desligar o Anki
Quando a IA terminar de criar cartas ou estudar, você ou a IA podem pedir para desligar:
> *"Pode desligar o Anki agora."*

A IA executará o `repository_dispatch` com:
* **Repositório:** `TouchRefletz/anki-cloud-actions`
* **`event_type`:** `stop-anki`

*(O workflow salva as alterações no AnkiWeb e desliga a máquina imediatamente).*

---

## 🔄 Fluxo de Execução

```
[Gemini Spark / Usuário]
         │
         ▼ (repository_dispatch: "start-anki")
[GitHub Actions (Ubuntu)]
         │
         ├─► Inicia Display Virtual Xvfb (:99)
         ├─► Instala Anki Oficial (Linux) + Addon AnkiMCP
         ├─► Login no AnkiWeb & Download da Coleção
         ├─► Inicia Ngrok (https://seu-dominio.ngrok-free.dev)
         │
         ▼
[Sessão Ativa na Nuvem] ◄─── Conexão MCP via Gemini Spark
         │
         ├─► Temporizador inteligente (ex: 30 min)
         │   OU evento "stop-anki" disparado
         │
         ▼
[Finalização Graciosa]
         ├─► Upload de alterações para o AnkiWeb (Sync)
         ├─► Encerramento do Ngrok e Anki
         └─► Runner finalizado com segurança!
```

---

## ⚠️ Dica Importante sobre o Ngrok
Como o Anki na nuvem usará o seu domínio fixo do Ngrok (`seu-dominio.ngrok-free.dev`), certifique-se de que o Ngrok local no seu computador não esteja rodando no mesmo domínio no exato momento da execução na nuvem, para evitar conflito de túnel.

---

## 📄 Licença
Distribuído sob a licença MIT. Sinta-se livre para utilizar, modificar e compartilhar com a comunidade!
