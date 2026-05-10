# ニュースリーダー (news-pwa)

興味のあるニュースをまとめて表示するPWA。
GitHub Actionsで1時間ごとにRSSを取得し、`news.json` を更新します。

## トピック
- 教育・ICT
- 商業・簿記・会計
- AI・プログラミング
- 北海道ローカル

## 構成
- フロント: 静的HTML/JS（GitHub Pages配信）
- データ取得: GitHub Actions（1時間ごと）
- ユーザー設定の同期: GitHub Gist

## 情報源の編集
PWA内の「設定」画面から追加・削除できます。
直接編集する場合は `feeds.json` を変更してください。
