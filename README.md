# AccSwitch

Troca rápida de conta nas CLIs de IA — e quanto do limite cada conta já gastou.

Cada CLI guarda o login em um arquivo JSON no seu `$HOME`. O AccSwitch tira um snapshot
desse arquivo em um perfil nomeado e restaura o perfil que você escolher. Sem passar por
login/OAuth de novo, sem abrir navegador.

```
accswitch save codex pessoal      # salva o login atual
codex login                       # loga na outra conta
accswitch save codex trabalho     # salva também
accswitch use codex pessoal       # a partir daqui, troca instantânea
```

## CLIs suportadas

| CLI | id | troca | limite usado |
| --- | --- | :---: | --- |
| Codex CLI (OpenAI) | `codex` | ✔ | ✔ % da janela (5h / 7d / 30d conforme o plano), reset, plano |
| Claude Code (Anthropic) | `claude` | ✔ | ✔ 5h e 7 dias (e por modelo, quando houver) |
| Gemini CLI (Google) | `gemini` | ✔ | só a conta |
| Grok CLI (xAI) | `grok` | ✔ | só a conta |
| GitHub Copilot CLI | `copilot` | ✔ | — |

Grok e Gemini não expõem endpoint de quota para a CLI. Outras CLIs que guardem login em
arquivo entram sem tocar código — ver [Adicionar outra CLI](#adicionar-outra-cli).

## Instalação (Windows)

Precisa só do [Node.js 20+](https://nodejs.org). Sem npm, sem administrador, sem clonar.
Cole no PowerShell:

```powershell
irm https://raw.githubusercontent.com/hadagalberto/AccSwitch/main/install.ps1 | iex
```

O script baixa o repositório, instala em `%LOCALAPPDATA%\AccSwitch`, cria os comandos
`accswitch` e `acs` e adiciona a pasta ao PATH do usuário. Abra um terminal novo depois.

Se o Node não estiver instalado e o `winget` existir, o script oferece instalar.

### Com opções

O pipe `| iex` não aceita parâmetros. Para passar `-Tray` (ou outro), use um scriptblock:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/hadagalberto/AccSwitch/main/install.ps1))) -Tray
```

| opção | efeito |
| --- | --- |
| `-Tray` | liga o ícone da bandeja e o coloca para iniciar com o Windows |
| `-Dest D:\Tools\AccSwitch` | instala em outra pasta |
| `-Branch dev` | instala de outro branch |
| `-Uninstall` | remove o programa; **mantém** os perfis salvos |
| `-Uninstall -PurgeVault` | remove também `~/.accswitch` (perfis e tokens) |

### Clonando o repositório

```powershell
git clone https://github.com/hadagalberto/AccSwitch
cd AccSwitch
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Rodado de dentro da pasta clonada, instala dali sem baixar nada.

### Desinstalar

```powershell
& "$env:LOCALAPPDATA\AccSwitch\install.ps1" -Uninstall
```

Sem instalar nada: `node src/cli.js <comando>` direto da pasta clonada.

## Comandos

| comando | o que faz |
| --- | --- |
| `accswitch` | seletor interativo: escolhe a CLI → escolhe a conta |
| `accswitch use <cli> [perfil]` | troca a conta ativa (pergunta o perfil se omitido) |
| `accswitch save <cli> [perfil]` | salva o login atual como perfil |
| `accswitch ls [cli]` | lista perfis salvos e qual está ativo |
| `accswitch rm <cli> <perfil>` | apaga um perfil |
| `accswitch mv <cli> <antigo> <novo>` | renomeia um perfil |
| `accswitch usage [cli] [--force]` | limite usado/restante de cada conta |
| `accswitch tray` | ícone na bandeja do Windows |
| `accswitch startup [on\|off]` | tray junto com o Windows |
| `accswitch doctor` | CLIs detectadas e arquivos de credencial encontrados |

`acs` é atalho para `accswitch`.

## Tray

```
accswitch tray
```

Um clique abre o menu com todas as contas de todas as CLIs, cada uma com o limite ao lado.
O segundo clique troca. A cor do ícone segue a conta mais pressionada: verde < 70 %,
amarelo 70–89 %, vermelho ≥ 90 %.

O menu tem ainda "Salvar login atual…", "Atualizar uso agora" e "Sair". É um script
PowerShell + WinForms (`tray/AccSwitchTray.ps1`) — sem Electron, sem dependência.

## Limite usado

```
accswitch usage
```

```
Codex CLI (OpenAI)
  * principal          ██████████ 30d 100%  voce@exemplo.com
      renova em 26d

Claude Code (Anthropic)
  * principal          ███████░░░ 5h 7% · 7d 71%  voce@exemplo.com
      renova em 3h
```

Funciona para contas **que não estão ativas**: o AccSwitch consulta a API com o token
guardado no perfil, sem precisar trocar. Cache de 5 min; `--force` ignora.

### Renovação de token

Access token dura poucas horas. Quando o do perfil está vencido, o AccSwitch renova com o
`refresh_token` — o mesmo que a CLI faz ao iniciar — e grava o resultado de volta no perfil
e no login ativo, porque o refresh token é rotacionado a cada uso.

**Não renova se a CLI daquela conta está rodando.** Renovar por fora invalidaria o token
que o processo vivo tem em memória e o deslogaria no meio da sessão. Nesse caso mostra o
último valor conhecido (`em uso - dado anterior`).

Refresh token morto (dias parado) → `precisa relogar`. Faça login na CLI e rode
`accswitch save <cli> <perfil>` de novo.

## Como funciona

- **Vault:** `~/.accswitch/` — perfis, backups, cache. No Windows a pasta fica com ACL
  restrita ao seu usuário (herança removida).
- **Conta detectada sozinha:** o e-mail sai do JWT que estiver dentro do arquivo de
  credencial. Se não houver, o perfil fica só com o nome que você deu.
- **Backup a cada troca:** o login atual vai para `~/.accswitch/backups/<cli>/<data>/`
  antes de ser sobrescrito (últimos 10). Se a cópia falhar no meio, o estado anterior volta.
- **Sem resíduo:** todos os arquivos gerenciados da CLI são removidos antes de aplicar o
  perfil, para que sobras da conta anterior não vazem para a nova.
- **Perfil ativo lê do login vivo**, não do snapshot — a CLI renova o próprio token enquanto
  roda, e o snapshot ficaria com um refresh token já rotacionado.

## Avisos

- O vault contém **tokens reais**. Não sincronize `~/.accswitch` com Drive/OneDrive/Git.
- Feche a CLI antes de trocar. Se estiver rodando, ela pode reescrever as credenciais ao
  sair e desfazer a troca. O AccSwitch avisa quando detecta o processo.
- Os endpoints de uso (`wham/usage`, `oauth/usage`) são internos dos provedores e podem
  mudar sem aviso. Se pararem, a troca continua funcionando; só o número some.

## Adicionar outra CLI

Crie `~/.accswitch/providers.json`:

```json
[
  {
    "id": "qwen",
    "name": "Qwen Code",
    "dir": ".qwen",
    "files": ["oauth_creds.json"],
    "required": ["oauth_creds.json"],
    "processes": ["qwen.exe"]
  }
]
```

`dir` é relativo ao `$HOME`; `files` são os arquivos que compõem o login; `processes` serve
para o aviso de "CLI rodando". Um `id` já existente sobrescreve o provider embutido.

Isso dá troca. Limite de uso exige um adaptador de API em `src/usage.js`.

## Estrutura

```
install.ps1            instalador / desinstalador
src/cli.js             comandos
src/vault.js           save / use / backup / restore
src/usage.js           limite por conta + renovação de token
src/providers.js       registro das CLIs e seus arquivos
src/identity.js        e-mail via JWT
src/picker.js          seletor por setas (zero dependência)
src/paths.js           vault + ACL
tray/AccSwitchTray.ps1 bandeja do Windows
```

Zero dependência npm. Node 20+ e PowerShell 5.1 (já vem no Windows).

> `tray/AccSwitchTray.ps1` precisa ficar em **UTF-8 com BOM**: o Windows PowerShell 5.1
> lê `.ps1` sem BOM como ANSI e os acentos quebram o parser.
