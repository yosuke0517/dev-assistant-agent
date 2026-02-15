# Finegate Stealth Agent - System Overview

## 🎯 目的
「外出先（スマホ/Slack）から自宅のMacBook Proをリモート操作し、受託開発案件をClaude Codeにステルス実行させる」ための自動化基盤。

## 🏗️ アーキテクチャ
[Slack (Command: /do)] 
      ↓ (HTTPS POST)
[Cloudflare Tunnel (agent.finegate.xyz)]
      ↓ (Secure Tunnel)
[Local MBP (Node.js Server)]
      ↓ (Exec)
[Claude Code] -> [GitHub Repository]

## 🛠️ 技術スタック
- **Network**: Cloudflare Tunnel (固定IP不要のセキュア公開)
- **Runtime**: Node.js / Express (指示待ちサーバー)
- **AI Engine**: Claude Code (実装・テスト・PR作成)
- **Identity**: Git Local Config (自身のコミット名義を強制)