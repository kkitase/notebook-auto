# NotebookLM URL Auto-Add

NotebookLMにWebサイトURLを自動的に追加・同期するツールです。

## アーキテクチャ

![アーキテクチャ図](architecture.jpeg)

## 機能

- **自動追加**: 設定ファイルに記載したURLを一括で追加
- **同期（Sync）**: リストにないソースを自動削除
- **重複チェック**: 既存ソースとの重複を防止

## セットアップ

### 1. セットアップ（初回のみ）

このコマンドで全ての依存パッケージとブラウザ（Chromium）がインストールされます。

```bash
npm run setup
```

### 2. 設定ファイルの作成

`config.env.example` を `config.env` にコピーして編集してください:

```bash
cp config.env.example config.env
```

`config.env` の内容:

```env
# 追加先 NotebookLM URL
NOTEBOOK_URL=https://notebooklm.google.com/notebook/your-notebook-id

# リストにないソースを削除するか（true/false）
SYNC_MODE=true

# URL リスト（1行1URL、#はコメント）
https://example.com/page1
https://example.com/page2
https://example.com/page3
```

## 使い方

プロジェクトのルートディレクトリで以下のコマンドを実行してください:

```bash
# パッケージをリンクして自作コマンドとして登録（一回のみ）
npm link

# 実行
notebook-auto
```

または、リンクせずに直接実行する場合:

```bash
npx .
```

## 注意事項

- 初回実行時はGoogleアカウントへのログインが必要です
- `playwright-session/` にセッション情報が保存されるため、2回目以降はログイン不要になる場合があります
- ブラウザウィンドウは閉じないでください（処理が中断されます）

## ファイル構成

```
notebook-auto/
├── index.js              # メインスクリプト
├── package.json
├── config.env            # 設定ファイル（要作成、Git管理外）
├── config.env.example    # 設定ファイルのサンプル
└── playwright-session/   # セッション保持用（自動生成）
```

## 技術スタック

- Node.js
- Playwright（ブラウザ自動化）
