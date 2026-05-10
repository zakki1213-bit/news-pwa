# news-summarizer (Cloudflare Worker)

ニュース記事URLを受け取り、本文を取得→Geminiで要約して返すWorker。

## デプロイ手順

### 1. wrangler を準備
```bash
cd /Users/yamazakidaisuke/claude/news-pwa/worker
npm install
```

### 2. Cloudflareにログイン
```bash
npx wrangler login
```
ブラウザが開いてCloudflareへの認可を求められます。「Allow」をクリック。

### 3. Gemini APIキーをシークレットとして登録
```bash
npx wrangler secret put GEMINI_API_KEY
```
`Enter a secret value:` と聞かれるので、APIキー（`AIzaSy...`）を貼り付けてEnter。

### 4. デプロイ
```bash
npx wrangler deploy
```
`https://news-summarizer.<your-subdomain>.workers.dev` のようなURLが返ります。
このURLをPWA側に設定します。

## API仕様

POST `/` (Origin: https://zakki1213-bit.github.io)
```json
{ "url": "https://example.com/article" }
```

レスポンス:
```json
// 成功
{ "ok": true, "summary": "・要約1\n・要約2\n..." }

// 取得失敗（HTTP 200で返す、PWA側でreasonを判定）
{ "ok": false, "reason": "fetch_failed" | "too_short", "message": "..." }
```
