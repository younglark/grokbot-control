/**
 * Playwright tests against the packed dist/dashboard/ tree (not the Vite dev server).
 * Skips if Chromium is not installed. Offline / --mock only.
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlane } from "../src/ops/plane.js";
import { staticTokenProvider } from "../src/auth/provider.js";
import { loggedOutMockProvider } from "../src/testing/mock-auth.js";
import { createEmptyMockState, createMockTransport, type MockState } from "../src/testing/mock-transport.js";
import { startDashboardServer, type StartedDashboard, resolveDashboardUiRoot } from "../src/localdash/server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiRoot = path.join(root, "dist/dashboard");

function hasUi(): boolean {
  return fs.existsSync(path.join(uiRoot, "index.html"));
}

async function maybeChromium() {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    return browser;
  } catch (e) {
    return null;
  }
}

function plane(state: MockState, loggedIn: boolean) {
  return new ControlPlane({
    baseUrl: "mock://gbc",
    transport: createMockTransport(state),
    simulated: true,
    auth: loggedIn
      ? staticTokenProvider({ kind: "cursor", backend: "mock://gbc", accessToken: "mock-token" })
      : loggedOutMockProvider({ kind: "cursor", backend: "mock://gbc" }),
  });
}

describe("packed dashboard UI (Playwright)", () => {
  it("assets load under /s/<random>/, unknown computer is not green running, unauth banner and usage labels appear", async (t) => {
    if (!hasUi()) {
      t.skip("dist/dashboard/index.html missing; run npm run build -w grokbot-control");
      return;
    }
    const browser = await maybeChromium();
    if (!browser) {
      t.skip("Playwright Chromium is not installed. Run: npx playwright install chromium");
      return;
    }
    let dash: StartedDashboard | undefined;
    try {
      // Unauthenticated first: login banner, unknown computer must not be 运行中 green.
      const loggedOut = createEmptyMockState();
      dash = await startDashboardServer({
        plane: plane(loggedOut, false),
        host: "127.0.0.1",
        port: 0,
        uiRoot,
      });
      const page = await browser.newPage();
      const res = await page.goto(dash.url, { waitUntil: "load" });
      assert.equal(res?.ok(), true);
      const failedAsset = [];
      page.on("response", (r) => {
        if (!r.ok() && /\/assets\//.test(r.url())) failedAsset.push(r.url());
      });
      await page.reload({ waitUntil: "load" });
      assert.equal(failedAsset.length, 0, `asset failures: ${failedAsset.join(", ")}`);
      const html = await page.content();
      assert.match(html, /gbc 本地监视器|尚未登录/);
      const banner = page.getByTestId("login-banner");
      await banner.waitFor({ timeout: 5_000 });
      assert.match(await banner.innerText(), /gbc auth login/);
      const chip = page.getByTestId("computer-chip");
      const tone = await chip.getAttribute("data-tone");
      assert.equal(tone, "unknown");
      const label = await chip.innerText();
      assert.ok(!/^运行中$/.test(label.trim()), label);
      assert.match(label, /未知/);
      const color = await page.getByTestId("computer-dot").evaluate((el) => getComputedStyle(el).backgroundColor);
      // Must not be a green running color. unknown uses muted gray/blue.
      // rgb of --good is distinctly green; reject if the dot is clearly green-dominant.
      const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
        assert.ok(!(g > r + 20 && g > b + 20), `computer dot should not be green, got ${color}`);
      }
      await dash.close();
      dash = undefined;

      // Logged-in usage chip with labeled unverified units.
      const loggedIn = createEmptyMockState();
      loggedIn.usageFixture = "near_exhausted";
      loggedIn.bots.push({
        id: "1",
        agentId: "agent-1",
        name: "demo",
        title: "Demo Bot",
        description: "",
      });
      loggedIn.statuses.push({
        agentId: "agent-1",
        isRunning: false,
        live: { agentId: "agent-1", isRunning: false, awaiting: { reason: "等待确认" } },
      });
      dash = await startDashboardServer({
        plane: plane(loggedIn, true),
        host: "127.0.0.1",
        port: 0,
        uiRoot,
      });
      const page2 = await browser.newPage();
      await page2.goto(dash.url, { waitUntil: "load" });
      const usage = page2.getByTestId("usage-chip");
      await usage.waitFor({ timeout: 8_000 });
      const usageText = await usage.innerText();
      assert.match(usageText, /单位未核实/);
      assert.match(usageText, /92/);
      await page2.getByText("Demo Bot").click();
      const detail = page2.getByTestId("bot-detail");
      await detail.waitFor();
      assert.match(await detail.innerText(), /等待确认/);
      assert.doesNotMatch(await detail.innerText(), /todos|tasks|timeline/i);
      assert.equal(await page2.locator("[data-testid=bot-todos]").count(), 0);
    } finally {
      if (dash) await dash.close();
      await browser.close();
    }
  });

  it("responsive shadcn layouts, themes, Sheet and Command keyboard interactions", async () => {
    assert.ok(hasUi(), "build packed UI first");
    const browser = await maybeChromium();
    assert.ok(browser, "Chromium required for responsive acceptance");
    const state = createEmptyMockState();
    state.usageFixture = "near_exhausted";
    state.sandbox.state = 0;
    const examples = [
      ["research", "研究助手", "持续整理重要资料与研究方向", true, ""],
      ["writing", "写作伙伴", "文章草稿与表达优化", false, "等待你的确认"],
      ["engineering", "工程观察员", "关注项目进展与技术变更", false, ""],
      ["notes", "知识整理", "归档、分类与检索", false, "等待授权"],
      ["brief", "每日简报", "你的每日信息摘要", true, ""],
    ] as const;
    for (const [id, title, description, running, reason] of examples) {
      state.bots.push({id, agentId:id, name:id, title, description});
      state.statuses.push({agentId:id, isRunning:running, live:{agentId:id,isRunning:running,...(reason?{awaiting:{reason}}:{})}});
    }
    const dash = await startDashboardServer({plane:plane(state,true),host:"127.0.0.1",port:0,uiRoot});
    // Optional fresh artifacts only; normal regression tests do not touch old /tmp screenshots.
    const shots = process.env.GBC_DASHBOARD_SCREENSHOTS;
    if(shots) fs.mkdirSync(shots,{recursive:true});
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", e=>errors.push(e.message));
      await page.goto(dash.url,{waitUntil:"load"});
      await page.getByTestId("bot-list").getByText("研究助手",{exact:true}).waitFor();
      for (const theme of ["light","dark"]) {
        await page.evaluate(v=>document.documentElement.classList.toggle("dark",v==="dark"),theme);
        for (const width of [1440,1024,768,390,320]) {
          await page.setViewportSize({width,height:1000});
          await page.reload({waitUntil:"load"});
          await page.getByTestId("bot-list").getByText("写作伙伴",{exact:true}).waitFor();
          await page.evaluate(v=>document.documentElement.classList.toggle("dark",v==="dark"),theme);
          await page.waitForTimeout(180);
          const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
          assert.equal(overflow,false,`${theme} ${width}px overflow`);
          assert.equal(await page.getByTestId("computer-chip").getAttribute("data-tone"),"unknown");
          if(shots) await page.screenshot({path:`${shots}/${theme}-${width}.png`,fullPage:true});
          await page.getByTestId("bot-list").getByText("写作伙伴",{exact:true}).click();
          await page.getByTestId("bot-detail").waitFor();
          if (width===768 || width===320) {
            if(shots) await page.screenshot({path:`${shots}/${theme}-${width}-detail.png`,fullPage:true});
          }
          if(width<900) await page.getByRole("button",{name:"返回列表"}).click();
          else if(width<1280) await page.keyboard.press("Escape");
        }
      }
      await page.setViewportSize({width:1440,height:1000});
      await page.getByTestId("usage-chip").click();
      await page.getByRole("heading",{name:"使用额度",exact:true}).waitFor();
      assert.match(await page.getByRole("dialog").innerText(),/单位未核实/);
      if(shots) await page.screenshot({path:`${shots}/dark-1440-usage.png`,fullPage:true});
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({state:"hidden"});
      await page.waitForTimeout(250);
      await page.getByRole("button",{name:"搜索命令"}).focus();
      await page.keyboard.press(process.platform==="darwin"?"Meta+k":"Control+k");
      await page.getByTestId("command-palette").waitFor();
      await page.getByPlaceholder("搜索 Bot 或命令…").fill("写作伙伴");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.getByTestId("command-palette").waitFor({state:"hidden"});
      await page.waitForTimeout(250);
      assert.equal(await page.getByRole("button",{name:"搜索命令"}).evaluate(el=>el===document.activeElement),true,"dialog restores focus");
      assert.deepEqual(errors,[]);
    } finally {await dash.close();await browser.close();}
  });

  it("collapsed sidebar centers icons and keeps controls clear of its divider", async () => {
    const browser=await maybeChromium();
    assert.ok(browser,"Chromium required for sidebar geometry acceptance");
    const state=createEmptyMockState();
    for(const id of ["running","waiting","unknown"]) {
      state.bots.push({id,agentId:id,name:id,title:id});
      if(id!=="unknown") state.statuses.push({agentId:id,isRunning:id==="running",live:{agentId:id,isRunning:id==="running",...(id==="waiting"?{awaiting:{reason:"等待确认"}}:{})}});
    }
    const dash=await startDashboardServer({plane:plane(state,true),host:"127.0.0.1",port:0,uiRoot});
    try {
      const page=await browser.newPage();
      for(const theme of ["light","dark"]) {
        for(const width of [1024,1440]) {
          await page.setViewportSize({width,height:1000});
          await page.goto(dash.url,{waitUntil:"load"});
          await page.evaluate(v=>document.documentElement.classList.toggle("dark",v==="dark"),theme);
          if(width===1440) await page.locator('[data-slot="sidebar-trigger"]').click();
          await page.waitForTimeout(300);
          await page.getByTestId("bot-list").getByText("running",{exact:true}).waitFor();
          const symbols=["activity","hourglass","circle-help"];
          for(const surface of ["sidebar","stats","list"]) {
            const shapes=[];
            for(const category of ["running","waiting","unknown"]) {
              const icon=page.locator(`[data-status-surface="${surface}"] [data-status-icon="${category}"]`);
              assert.equal(await icon.count(),1,`${surface}: ${category} icon`);
              shapes.push(await icon.getAttribute("data-status-symbol"));
              if(category==="unknown") {
                assert.match(await icon.getAttribute("class")??"",/text-muted-foreground/);
                assert.doesNotMatch(await icon.getAttribute("class")??"",/text-status-running|emerald|green/);
              }
            }
            assert.deepEqual(shapes,symbols,`${surface}: categories must have distinct symbols`);
          }
          const unknownNav=page.locator('[data-status-surface="sidebar"]').filter({has:page.locator('[data-status-icon="unknown"]')});
          assert.match(await unknownNav.getAttribute("aria-label")??"",/不等于离线/);
          const measurements=await page.evaluate(()=>{
            const shell=document.querySelector('[data-slot="sidebar-container"]')!;
            const box=shell.getBoundingClientRect();
            const border=parseFloat(getComputedStyle(shell).borderRightWidth);
            const selectors=['[data-testid="sidebar-brand-mark"]','[data-slot="sidebar-header"] svg','[data-slot="sidebar-footer"] svg','[data-slot="sidebar-menu-button"]'];
            return {width:box.width,border,rail:!!document.querySelector('[data-slot="sidebar-rail"]'),items:selectors.flatMap(selector=>Array.from(shell.querySelectorAll(selector)).map(el=>{const r=el.getBoundingClientRect();const icon=el.tagName.toLowerCase()==="svg"?r:el.querySelector("svg")!.getBoundingClientRect();return {selector,width:r.width,left:r.left-box.left,right:box.right-border-r.right,iconCenter:icon.left+icon.width/2-box.left,expectedCenter:(box.width-border)/2}}))};
          });
          console.log(`sidebar geometry ${theme} ${width}: ${JSON.stringify(measurements)}`);
          for(const item of measurements.items) {
            assert.ok(item.left>=7,`${theme}/${width} ${item.selector}: left gap ${item.left}`);
            assert.ok(item.right>=7,`${theme}/${width} ${item.selector}: divider gap ${item.right}`);
            assert.ok(Math.abs(item.iconCenter-item.expectedCenter)<=1,`${theme}/${width} ${item.selector}: icon off center ${item.iconCenter-item.expectedCenter}`);
            if(item.selector.includes("menu-button")) assert.ok(item.width>=32,"navigation click target must not shrink");
          }
          if(width===1440) {
            await page.locator('[data-slot="sidebar-trigger"]').click();
            await page.waitForTimeout(300);
            assert.equal(await page.locator('[data-slot="sidebar-container"]').evaluate(el=>el.getBoundingClientRect().width),256,"expanded sidebar width unchanged");
          }
        }
      }
    } finally {await dash.close();await browser.close();}
  });

  it("resolveDashboardUiRoot finds the packed tree after build", () => {
    if (!hasUi()) return;
    const resolved = resolveDashboardUiRoot();
    assert.ok(resolved);
    assert.equal(path.resolve(resolved!), path.resolve(uiRoot));
  });
});
