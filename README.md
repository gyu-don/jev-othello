# Jev Othello

TypeSafe AI の評価モデル Jev とローカルで対戦するオセロです。ブラウザへ API キーを渡さず、Node.js サーバーから公式 SDK を呼びます。

## 必要なもの

- Node.js 24 以降
- npm
- Doppler CLI
- Doppler に設定済みの `TYPESAFE_API_KEY`

## 起動

```sh
npm install
doppler run -- npm start
```

`http://127.0.0.1:3000` を開きます。サーバーはループバックアドレスだけで待ち受けるため、同じPCからのみ接続できます。

型チェック:

```sh
npm run check
```

## 利用上限

初期値では、1回のサーバー起動につき Jev を最大80回、1分あたり最大20回呼び出します。上限は環境変数で変更できます。

```sh
JEV_MAX_REQUESTS=40 JEV_REQUESTS_PER_MINUTE=10 doppler run -- npm start
```

上限はサーバーを再起動するとリセットされます。外部公開用の永続的なレート制限ではなく、ローカル利用時の誤操作・ループ対策です。
