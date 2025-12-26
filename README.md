# Siscord

Discord を「ブラウザとして」開き、外部から **CSS（テーマ）だけ** を注入して見た目を変える Electron アプリです。

- Discord クライアント本体の改変はしません
- Discord の設定へ項目を紛れ込ませません
- BetterDiscord のようなプラグイン機構は持ちません
- 注入は `webContents.insertCSS` による CSS のみ（JS は注入しません）

## テーマ互換

BetterDiscord 互換のテーマファイル（`.theme.css` / `.css`）をインポートできます。

また、以下のような危険な/非互換な構文は除去します。
- `url(javascript:...)`
- `expression(`
- `behavior: ...;`（古いIEの互換用）

※ CSS 自体は表現力が高いため、これは「安全境界」ではなく互換/予防のためのフィルタです。

## 使い方

```bash
cd Siscord
npm install
npm run start
```

起動後、メニュー `Siscord > Theme Settings…` からテーマをインポート/選択できます。

## テーマ保存場所

テーマはOSのユーザーデータ配下に保存します（アプリが自動作成）。
- Windows: `%APPDATA%/Siscord/themes`

