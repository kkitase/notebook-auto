#!/usr/bin/env node
/**
 * NotebookLM URL Auto-Add
 * Node.js + Playwright版
 *
 * 処理フロー:
 * 1. 設定読み込み & タイトル事前取得
 * 2. 同期（Sync）:
 *    - 現在の全ソースを分析
 *    - リストにあるURLと対応付け
 *    - リストになく、SYNC_MODE=trueなら削除
 *    - 削除は1回につき1件のみ行い、DOMを再評価する（安全性優先）
 * 3. 追加（Add）:
 *    - リストにあるが、ソースに存在しないURLを追加
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

// 設定
const CONFIG = {
  configPath: path.join(__dirname, "config.env"),
  userDataDir: path.join(__dirname, "playwright-session"),
  waitTime: {
    short: 500,
    medium: 1000,
    long: 3000,
    veryLong: 8000,
  },
};

/** Utility: Sleep */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Utility: Config Loader */
function loadConfig() {
  try {
    const content = fs.readFileSync(CONFIG.configPath, "utf-8");
    const lines = content.split("\n");
    const notebooks = [];
    const allUniqueUrls = new Set();

    let currentNotebook = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || trimmed === "") continue;

      // 新しいノートブックセクションの開始
      if (trimmed.startsWith("NOTEBOOK_URL=")) {
        const match = trimmed.match(/NOTEBOOK_URL=(.+)/);
        if (match && match[1].startsWith("http")) {
          currentNotebook = {
            notebookUrl: match[1].trim(),
            syncMode: true, // デフォルト
            urls: [],
          };
          notebooks.push(currentNotebook);
        }
        continue;
      }

      // 同期モード設定 (現在のノートブックに対して適用)
      if (trimmed.startsWith("SYNC_MODE=")) {
        const match = trimmed.match(/SYNC_MODE=(.+)/);
        if (match && currentNotebook) {
          currentNotebook.syncMode = match[1].toLowerCase().includes("true");
        }
        continue;
      }

      // URL リスト (現在のノートブックに追加)
      if (trimmed.startsWith("http")) {
        if (currentNotebook) {
          currentNotebook.urls.push(trimmed);
        }
        allUniqueUrls.add(trimmed);
      }
    }

    console.log(
      `📋 設定から ${notebooks.length} 件のノートブックを読み込みました`
    );
    notebooks.forEach((nb, i) => {
      console.log(
        `  📓 [${i + 1}] URL: ${nb.notebookUrl} (${nb.urls.length}件, SYNC:${
          nb.syncMode
        })`
      );
    });
    console.log(`📋 総ユニークURL数: ${allUniqueUrls.size} 件`);

    return { notebooks, allUrls: Array.from(allUniqueUrls) };
  } catch (error) {
    console.error("❌ 設定ファイルの読み込みに失敗:", error.message);
    return { notebooks: [], allUrls: [] };
  }
}

/** Utility: String Normalizer */
function normalizeString(str) {
  if (!str) return "";
  return str.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

/** Action: Fetch Page Titles */
async function fetchPageTitles(browser, urls) {
  console.log("\n🔍 各URLのページタイトルを取得しています...");
  const urlTitles = {};
  const page = await browser.newPage();

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      const title = await page.title();
      urlTitles[url] = title.trim();
      console.log(
        `  📄 [${i + 1}/${urls.length}] タイトル取得: ${title.substring(
          0,
          40
        )}...`
      );
    } catch (e) {
      console.log(`  ⚠️ タイトル取得失敗: ${url} (${e.message})`);
      urlTitles[url] = "";
    }
  }
  await page.close();
  return urlTitles;
}

/** Action: Get Existing Source Rows (改善版) */
async function getExistingSourceRows(page) {
  // ソース行を取得（mat-checkboxを含むdiv）
  // ただし、ヘッダー行（「すべてのソース」など）は除外
  const allRows = page
    .locator("div:has(mat-checkbox)")
    .filter({ hasNotText: "すべてのソース" });

  const count = await allRows.count();
  const results = [];
  const seenTitles = new Set(); // 重複検出用

  for (let i = 0; i < count; i++) {
    const row = allRows.nth(i);

    // メニューボタン（3点リーダー）が存在するかチェック
    const hasMenuButton = (await row.locator("button mat-icon").count()) > 0;

    if (!hasMenuButton) {
      // メニューボタンがない行はヘッダーなので無視
      continue;
    }

    const text = await row.innerText();
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const title = lines.sort((a, b) => b.length - a.length)[0] || "";

    // 重複検出：同じタイトルの行は2回目以降スキップ（入れ子対策）
    if (seenTitles.has(title)) {
      continue;
    }
    seenTitles.add(title);

    results.push({
      originalIndex: i,
      title: title || "(タイトル不明)",
      text: text,
      locator: row,
    });
  }
  return results;
}

/** Check Match */
function isMatch(rowTitleOrObj, configTitleOrObj, url = null, debug = false) {
  const rowTitle =
    typeof rowTitleOrObj === "string" ? rowTitleOrObj : rowTitleOrObj?.title;
  const configTitle =
    typeof configTitleOrObj === "string"
      ? configTitleOrObj
      : configTitleOrObj?.title;

  const rowTitleNorm = normalizeString(rowTitle);
  const configTitleNorm = normalizeString(configTitle);

  if (debug) {
    console.log(`      [比較] config: "${configTitle?.substring(0, 40)}..."`);
    console.log(
      `        正規化後: row="${rowTitleNorm.substring(
        0,
        25
      )}..." vs config="${configTitleNorm.substring(0, 25)}..."`
    );
  }

  // タイトル一致で判定
  if (configTitleNorm.length > 0 && rowTitleNorm.length > 0) {
    // 1. 部分一致
    if (
      rowTitleNorm.includes(configTitleNorm) ||
      configTitleNorm.includes(rowTitleNorm)
    ) {
      if (debug) console.log(`        → ✓ 部分一致でマッチ`);
      return true;
    }

    // 2. 先頭20文字で比較（タイトルが切り詰められている場合の対策）
    const prefixLength = 20;
    const rowPrefix = rowTitleNorm.substring(0, prefixLength);
    const configPrefix = configTitleNorm.substring(0, prefixLength);
    if (rowPrefix === configPrefix) {
      if (debug) console.log(`        → ✓ 先頭一致でマッチ`);
      return true;
    }

    if (debug) console.log(`        → ✗ 不一致`);
  }

  return false;
}

/** Action: Sync */
async function syncSources(page, configItems, syncMode = true) {
  if (!syncMode) return;
  console.log("\n" + "=".repeat(50));
  console.log("🧹 [フェーズ1] ソース同期（分析とクリーンアップ）");
  console.log("=".repeat(50));

  const validConfigItems = configItems.filter((item) => item.title !== "");

  const MAX_LOOPS = 50;
  let loopCount = 0;

  while (loopCount < MAX_LOOPS) {
    loopCount++;
    console.log(`\n🔄 スキャン Round ${loopCount}...`);

    const currentRows = await getExistingSourceRows(page);
    console.log(`📋 有効なソース数: ${currentRows.length} 件`);

    // 各ソースのタイトルをログ出力（デバッグ用）
    if (loopCount === 1) {
      console.log("📋 検出されたソース一覧:");
      currentRows.forEach((row, idx) => {
        console.log(`   [${idx}] ${row.title.substring(0, 40)}...`);
      });
    }

    let targetRow = null;
    let deleteReason = "";
    let deleteTitle = "";

    const matches = {};
    validConfigItems.forEach((c) => (matches[c.url] = []));
    const unlistedRows = [];

    for (let i = 0; i < currentRows.length; i++) {
      const row = currentRows[i];
      let matchedUrl = null;
      for (const config of validConfigItems) {
        if (isMatch(row, config)) {
          matchedUrl = config.url;
          break;
        }
      }
      if (matchedUrl) {
        matches[matchedUrl].push(i);
      } else {
        // マッチしなかった場合、デバッグログを出力
        if (loopCount === 1) {
          console.log(
            `    ⚠️ マッチしなかったソース [${i}]: "${row.title.substring(
              0,
              40
            )}..."`
          );
          // 各config.titleとの比較をデバッグ表示
          for (const config of validConfigItems) {
            isMatch(row, config, null, true); // debug=true
          }
        }
        unlistedRows.push(row);
      }
    }

    // リスト外削除のみ実行
    if (unlistedRows.length > 0) {
      targetRow = unlistedRows[0];
      deleteReason = "リスト外 (Sync Mode)";
      deleteTitle = targetRow.title;
    }

    if (targetRow) {
      console.log(
        `  🗑️ 削除実行: "${deleteTitle.substring(0, 40)}..." (${deleteReason})`
      );

      const success = await deleteRow(page, targetRow.locator);
      if (success) {
        console.log("    ⌛️ 更新待機...");
        await sleep(3000);
      } else {
        console.log("    ⚠️ 削除失敗。次のソースへ");
        // 失敗しても次の可能性を試す（DOMが変わる可能性）
        await sleep(2000);
      }
    } else {
      console.log("  ✨ 削除/整理対象はありません。クリーンアップ完了。");
      break;
    }
  }
}

/** Helper: Delete Row (堅牢版) */
async function deleteRow(page, rowLocator) {
  try {
    // 1. メニューボタン (3点リーダー) を探す
    const menuButton = rowLocator
      .locator("button")
      .filter({ has: page.locator("mat-icon") })
      .first();

    // ホバーして表示させる
    try {
      await rowLocator.hover({ force: true, timeout: 1000 });
    } catch (e) {}
    await sleep(300);

    // メニュークリック (force: true で確実に)
    if ((await menuButton.count()) > 0) {
      await menuButton.click({ force: true });
      await sleep(500);
    } else {
      console.log("    ⚠️ メニューボタンが見つかりません");
      return false;
    }

    // 2. 削除メニュー項目を探してクリック
    const deleteMenuItem = page
      .locator('button[role="menuitem"]')
      .filter({ hasText: /ソースを削除|Delete/ })
      .first();
    await deleteMenuItem.waitFor({ state: "visible", timeout: 3000 });
    await deleteMenuItem.click();
    await sleep(1000);

    // 3. 確認ダイアログの削除ボタン
    const confirmButton = page
      .locator("mat-dialog-container button")
      .filter({ hasText: /削除|Delete/ })
      .last();
    await confirmButton.waitFor({ state: "visible", timeout: 3000 });
    await confirmButton.click();

    console.log("    ✅ 削除成功");
    return true;
  } catch (e) {
    console.error(`    ❌ 削除操作失敗: ${e.message}`);
    try {
      await page.keyboard.press("Escape");
    } catch {}
  }
  return false;
}

/** Action: Add Multiple URLs at Once (一括追加) */
async function addUrlsToNotebook(page, urls) {
  if (urls.length === 0) return { success: true, addedCount: 0 };

  console.log(`  📥 ${urls.length}件のURLを一括追加中...`);
  try {
    const sourceTab = page
      .locator('div[role="tab"], button[role="tab"]')
      .filter({ hasText: /^ソース$/ });
    if ((await sourceTab.count()) > 0) {
      await sourceTab.first().click({ force: true });
      await sleep(CONFIG.waitTime.medium);
    }

    const addButton = page
      .locator("button")
      .filter({ hasText: /ソースを追加|Add source/ })
      .first();
    await addButton.waitFor({ state: "visible", timeout: 10000 });

    const websiteOption = page
      .locator('mat-chip, .mat-mdc-chip, [role="button"]')
      .filter({ hasText: /ウェブサイト|Website/ })
      .first();

    let isMenuOpen = false;
    for (let i = 0; i < 3; i++) {
      await addButton.click();
      await sleep(1000);
      if (await websiteOption.isVisible()) {
        isMenuOpen = true;
        break;
      }
      console.log("    ...メニューが開かないため再クリック");
    }

    if (!isMenuOpen) {
      await addButton.click({ force: true });
      await sleep(2000);
    }

    const dialog = page.locator("mat-dialog-container").first();
    let isDialogVisible = false;

    for (let i = 0; i < 3; i++) {
      await websiteOption.click();
      try {
        await dialog.waitFor({ state: "visible", timeout: 3000 });
        isDialogVisible = true;
        break;
      } catch (e) {
        console.log("    ...ダイアログが開かないため再クリック");
        if (await websiteOption.isVisible()) {
          await websiteOption.click({ force: true });
        }
      }
    }

    if (!isDialogVisible) {
      await dialog.waitFor({ state: "visible", timeout: 10000 });
    }

    // 複数URLを改行区切りで入力
    const urlInput = dialog.locator('textarea, input[type="text"]').first();
    const combinedUrls = urls.join("\n");
    await urlInput.fill(combinedUrls);
    console.log(`    ${urls.length}件のURLを入力完了`);
    await sleep(CONFIG.waitTime.medium);

    const insertButton = dialog
      .locator("button")
      .filter({ hasText: /挿入|Insert/ })
      .first();
    await insertButton.waitFor({ state: "visible", timeout: 10000 });
    if (!(await insertButton.isDisabled())) {
      await insertButton.click();
    } else {
      await insertButton.click({ force: true });
    }

    console.log("    処理完了待機...");
    // 複数URLの場合は待機時間を長めに
    await sleep(CONFIG.waitTime.veryLong * Math.min(urls.length, 5));
    console.log(`  ✅ 一括追加成功 (${urls.length}件)`);
    return { success: true, addedCount: urls.length };
  } catch (error) {
    console.log(`  ❌ 追加失敗: ${error.message}`);
    try {
      await page.keyboard.press("Escape");
    } catch {}
    return { success: false, error: error.message };
  }
}

/** Action: Wait for Manual Login */
async function waitForManualLogin(page) {
  console.log("\n" + "=".repeat(60));
  console.log("🛑 【ユーザー操作が必要です】");
  console.log(
    "1. Chrome等のエラー/復元ダイアログが出ている場合は閉じてください。"
  );
  console.log(
    "2. Googleアカウントにログインし、NotebookLMの画面が表示されるまで待ってください。"
  );
  console.log(
    "3. 準備ができたら、このターミナルで [Enter] キーを押してください..."
  );
  console.log("=".repeat(60));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  await new Promise((resolve) => {
    rl.question("", () => {
      rl.close();
      resolve();
    });
  });

  console.log("▶️ 処理を再開します...");
  try {
    await page.bringToFront();
  } catch (e) {}

  return true;
}

/** MAIN */
async function main() {
  console.log(
    "🚀 NotebookLM URL Auto-Add (Playwright版) - Multi-Notebook Support"
  );
  console.log(
    "================================================================\n"
  );

  const { notebooks, allUrls } = loadConfig();
  if (notebooks.length === 0) {
    console.log("❌ 設定不足（ノートブックが設定されていません）");
    return;
  }

  console.log("\n🌐 ブラウザ起動 & 事前準備...");
  const context = await chromium.launchPersistentContext(CONFIG.userDataDir, {
    headless: false,
    channel: "chrome", // システムのChromeを使用
    viewport: { width: 1280, height: 800 },
    args: ["--no-first-run", "--disable-search-engine-choice-screen"],
  });

  try {
    // 1. 全てのユニークURLのタイトルを一括取得
    const urlTitles = await fetchPageTitles(context, allUrls);
    const page = await context.newPage();

    // 2. 各ノートブックを順番に処理
    for (let i = 0; i < notebooks.length; i++) {
      const { notebookUrl, urls, syncMode } = notebooks[i];
      console.log(`\n🔄 [${i + 1}/${notebooks.length}] 処理中: ${notebookUrl}`);
      console.log(
        "================================================================"
      );

      await page.goto(notebookUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      // ログイン待機（最初のノートブック、かつセッションがない場合）
      if (i === 0) {
        const loggedIn = await waitForManualLogin(page);
        if (!loggedIn) {
          console.log("❌ ログインが確認できなかったため、中断します");
          break;
        }
      } else {
        // 2つ目以降は少し待機して安定させる
        await sleep(CONFIG.waitTime.long);
      }

      // 同期（古いソースの削除）
      const configItems = urls.map((url) => ({
        url,
        title: urlTitles[url] || "",
      }));
      await syncSources(page, configItems, syncMode);

      // 追加
      const missingUrls = [];
      const { rows } = await getExistingSourceRows(page);
      for (const url of urls) {
        const title = urlTitles[url] || "";
        const exists = rows.some((row) => isMatch(row.title, title, url));
        if (!exists) missingUrls.push(url);
      }

      if (missingUrls.length > 0) {
        console.log(
          `\n➕ 不足しているURLを追加します (${missingUrls.length}件)`
        );
        await addUrlsToNotebook(page, missingUrls);
      } else {
        console.log("\n✨ 全てのURLが登録済みです。");
      }
    }

    console.log("\n🎉 全てのノートブックの処理が完了しました！");
    console.log("30秒後にブラウザを閉じます...");
    await sleep(30000);
  } catch (error) {
    console.error("\n❌ 実行エラー:", error);
  } finally {
    await context.close();
    process.exit(0);
  }
}

main();
