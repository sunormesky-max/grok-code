# Security Policy

## Supported versions

Security fixes target the latest `main` branch of GrokCode.

## Reporting a vulnerability

Please **do not** open a public issue for secrets or remote code risks.

- Prefer GitHub **Private vulnerability reporting** (Security tab) when enabled  
- Or contact maintainers via a private channel listed on the org/profile  

Include: impact, reproduction steps, and affected commit/version.

## Secrets

- Never commit `XAI_API_KEY`, GitHub PATs, or MCP tokens  
- Use environment variables or `~/.grok` / app Settings  
- If a token is exposed: **revoke it on the provider**, rotate, and audit git history  

## Scope

GrokCode spawns the local **Grok CLI** and can run tools with auto-approve (YOLO).  
Treat YOLO mode as full trust for that workspace. Use deny rules / non-YOLO when untrusted.
