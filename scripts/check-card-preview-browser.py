"""Synthetic Obsidian DOM preview: no vault, server, account or production data."""
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BUILD = """
require('esbuild').build({stdin:{contents:'export {checklistPreviewRows,renderInlinePreview,wrapTaskText} from "./src/metadata.ts"; export {cardPreview,tagOnly} from "./cloud/shared/card-preview.mjs";',resolveDir:process.cwd()},bundle:true,write:false,format:'iife',globalName:'Preview',plugins:[{name:'obsidian-stub',setup(build){build.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'stub'}));build.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export const getLanguage=()=>"en";'}));}}]}).then(r=>process.stdout.write(r.outputFiles[0].text));
"""
bundle = subprocess.check_output(["node", "-e", BUILD], cwd=ROOT, text=True, encoding="utf-8")
css = (ROOT / "styles.css").read_text(encoding="utf-8")
with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge")
    try:
        page = browser.new_page(viewport={"width": 1200, "height": 1000})
        page.set_content('<style>body{font:16px Arial;background:#fbf8f1;--background-secondary:#fff;--background-modifier-border:#e2d9c3;--text-normal:#14213d;--text-muted:#56607a;--interactive-accent:#315fb4}article{width:260px;margin:16px}button{background:transparent;border:1px solid #e2d9c3;border-radius:6px}</style><style>' + css + '</style><main class="jotdrop-view"></main>')
        page.add_script_tag(content=bundle)
        page.evaluate("""() => {
          const make=(tag,opts={},ns)=>{const el=ns?document.createElementNS(ns,tag):document.createElement(tag);if(opts.cls)el.setAttribute('class',opts.cls);if(opts.text)el.textContent=opts.text;for(const [k,v] of Object.entries(opts.attr||{}))el.setAttribute(k,v);return el;};
          HTMLElement.prototype.appendText=function(text){this.append(document.createTextNode(text));};
          HTMLElement.prototype.createEl=function(tag,opts){const el=make(tag,opts);this.append(el);return el;};
          HTMLElement.prototype.createSpan=function(opts){return this.createEl('span',opts);};
          HTMLElement.prototype.hasClass=function(cls){return this.classList.contains(cls);};
          Element.prototype.createSvg=function(tag,opts){const el=make(tag,opts,'http://www.w3.org/2000/svg');this.append(el);return el;};
          window.createSpan=opts=>make('span',opts);
          window.showPreview=(name,body)=>{
            const card=make('article',{cls:'jotdrop-card'}); card.dataset.name=name;
            card.append(make('span',{cls:'jotdrop-card-paper'}));
            card.append(make('h3',{cls:'jotdrop-card-title',text:`Synthetic ${name}`}));
            const host=make('div',{cls:'jotdrop-card-preview'});card.append(host);document.querySelector('main').append(card);
            const rows=Preview.checklistPreviewRows(body);
            Preview.cardPreview(host,rows,{isTask:r=>r.index!==undefined,isChecked:r=>Boolean(r.checked),isMeta:r=>Preview.tagOnly(r.text),render:(r,asText)=>{
              const el=make('div',{cls:r.index===undefined||asText?'jotdrop-preview-line':'jotdrop-preview-task'});
              if(r.index===undefined||asText)el.textContent=r.text;else{Preview.renderInlinePreview(el,r.text,r.index);Preview.wrapTaskText(el);el.querySelector('.jotdrop-task-text').dataset.previewTaskText='';el.querySelector('button').setAttribute('aria-label',r.text.slice(2));}
              return el;
            },height:()=>innerHeight,openLabel:n=>n?`Open note - ${n} more tasks`:'Open note',checkedLabel:n=>`+ ${n} checked items`,open:()=>{window.opened=name;}});
          };
        }""")
        def state(card):
            host = card.locator(".jotdrop-card-preview")
            return {k: host.get_attribute(f"data-{k}") for k in ["mode", "visible-tasks", "hidden-tasks", "checked-tasks"]}

        # Like Keep: up to 10 open tasks at once, no More/Less; checked ones fold into "+ N checked items".
        for count in [1, 5, 10, 11, 12, 100]:
            body = "# Title\n" + "\n".join(f"- [ ] task {i + 1}" for i in range(count))
            page.evaluate("([name,body])=>showPreview(name,body)", [str(count), body])
            card = page.locator(f'[data-name="{count}"]')
            assert state(card) == {"mode": "checklist", "visible-tasks": str(min(count, 10)), "hidden-tasks": str(max(0, count - 10)), "checked-tasks": "0"}, (count, state(card))
            assert card.locator('[data-preview-action="toggle"]').count() == 0
            assert card.locator('[data-preview-action="open"]').count() == (1 if count > 10 else 0)
        page.evaluate("body=>showPreview('checked',body)", "# Title\n" + "\n".join(f"- [{'x' if i % 2 else ' '}] task {i + 1}" for i in range(15)))
        card = page.locator('[data-name="checked"]')
        assert state(card) == {"mode": "checklist", "visible-tasks": "8", "hidden-tasks": "0", "checked-tasks": "7"}, state(card)
        # Original writer indices survive the reordering: open task 15 is checklist item 14.
        assert card.locator('button[data-checklist-index="14"]').count() == 1
        assert card.locator('button[data-checklist-index="1"]').count() == 0
        assert card.locator('[data-preview-action="checked"]').text_content() == "+ 7 checked items", card.locator('[data-preview-action="checked"]').evaluate("el=>[el.innerText, getComputedStyle(el).textTransform]")
        page.evaluate("body=>showPreview('plain',body)", "# Title\nPlain text")
        assert state(page.locator('[data-name="plain"]'))["mode"] == "text"
        # Any other text makes it a text card: tasks as ☐/☑ text, no checkboxes.
        page.evaluate("body=>showPreview('mixed',body)", "# Title\nIntro\n- [ ] A\n- [x] B")
        mixed = page.locator('[data-name="mixed"]')
        assert state(mixed)["mode"] == "text" and mixed.locator("button[data-checklist-index]").count() == 0
        mixed_text = mixed.locator(".jotdrop-card-preview").text_content()
        assert "☐ A" in mixed_text and "☑ B" in mixed_text, repr(mixed_text)
        # A line of only hashtags and a link-preview marker are no text: still a checklist.
        page.evaluate("body=>showPreview('tagged',body)", "# Title\n- [ ] milk\n- [ ] bread\n\n#groceries #shop\n<!-- jotdrop-preview: pending -->")
        assert state(page.locator('[data-name="tagged"]'))["mode"] == "checklist"
        page.evaluate("body=>showPreview('article',body)", "# Title\n" + "Article sentence. " * 300 + "\n- [ ] A\n- [ ] B\n- [x] C")
        card = page.locator('[data-name="article"]')
        assert state(card)["mode"] == "text" and card.locator("button[data-checklist-index]").count() == 0
        assert card.locator('[data-preview-action="open"]').inner_text() == "Open note"
        intro = card.locator(".jotdrop-card-preview").inner_text()
        assert intro.startswith("Article sentence.") and intro.endswith("…"), intro[-60:]
        page.evaluate("body=>showPreview('long',body)", "# Title\n" + "\n".join("- [ ] " + ("Unicode café 漢字 🙂 " * 30) for _ in range(11)))
        shots = Path(tempfile.gettempdir()) / "kilo" / "compact-card-checks"
        shots.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(shots / "obsidian-desktop.png"), full_page=True)
        for width, height, size in [(390, 844, "16px"), (1200, 900, "32px"), (844, 390, "16px")]:
            page.set_viewport_size({"width": width, "height": height})
            # A zoom or font change resizes the window in the apps; headless Edge after a screenshot only delivers that event.
            page.locator("body").evaluate("(el,size)=>{el.style.fontSize=size;dispatchEvent(new Event('resize'))}", size)
            page.wait_for_timeout(200)
            for host in page.locator(".jotdrop-card-preview").all():
                sizes = host.evaluate("el=>({h:el.offsetHeight,cap:parseFloat(el.style.maxHeight),rows:[...el.querySelectorAll('.jotdrop-preview-task')].map(r=>r.getBoundingClientRect().bottom-el.getBoundingClientRect().bottom)})")
                assert sizes["h"] <= sizes["cap"] + 1, sizes
                assert all(bottom <= 1 for bottom in sizes["rows"]), sizes
            if width == 390:
                page.screenshot(path=str(shots / "obsidian-mobile.png"), full_page=True)
        print("Obsidian synthetic DOM (Keep model): 1/5/10/11/12/100, checked folded, original indices, mixed = text, tag line, article, small viewport and 200% text PASS")
    finally:
        browser.close()
