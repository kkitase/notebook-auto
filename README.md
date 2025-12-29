# NotebookLM URL Auto-Add

NotebookLMにWebサイトURLを自動的に追加・同期するツールです。

## アーキテクチャ

![アーキテクチャ図](architecture.jpeg)

## 機能

- **自動追加**: 設定ファイルに記載したURLを一括で追加
- **同期（Sync）**: リストにないソースを自動削除
- **重複チェック**: 既存ソースとの重複を防止

## セットアップ

`npm start` を実行すると自動的に必要なパッケージがインストールされます。

### 1. 設定ファイルの作成

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
# 実行（依存パッケージも自動インストールされます）
npm start
```

### 自作コマンドとして登録する場合

一度だけ以下のコマンドを実行すると、システムに `notebook-auto` コマンドが登録されます。

```bash
# パッケージをリンク
npm link

# 以降はこれだけで実行可能
notebook-auto
```

### 補足
本ツールはシステムにインストール済みの **Google Chrome** を使用します。別途ブラウザのインストールは不要です。

## ファイル構成

```
notebook-auto/
├── index.js              # メインスクリプト
├── package.json
├── config.env            # 設定ファイル（要作成、Git管理外）
├── config.env.example    # 設定ファイルのサンプル
├── architecture.jpeg     # アーキテクチャ図
├── .gitignore            # Git除外設定
├── note/                 # メモ・画像フォルダ（Git管理外）
└── playwright-session/   # セッション保持用（自動生成）
```

## 技術スタック

- Node.js
- Playwright（ブラウザ自動化 / システムのChromeを制御）
