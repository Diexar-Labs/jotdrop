"""Synthetic Obsidian DOM preview: no vault, server, account or production data."""
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BUILD = """
require('esbuild').build({stdin:{contents:'export {checklistPreviewRows,renderInlinePreview,wrapTaskText} from "./src/metadata.ts"; export {cardPreview} from "./cloud/shared/card-preview.mjs";',resolveDir:process.cwd()},bundle:true,write:false,format:'iife',globalName:'Preview',plugins:[{name:'obsidian-stub',setup(build){build.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'stub'}));build.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export const getLanguage=()=>"en";'}));}}]}).then(r=>process.stdout.write(r.outputFiles[0].text));
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
            let expanded=false;
            const rows=Preview.checklistPreviewRows(body);
            Preview.cardPreview(host,rows,{isTask:r=>r.index!==undefined,render:r=>{
              const el=make('div',{cls:r.index===undefined?'jotdrop-preview-line':'jotdrop-preview-task'});
              if(r.index===undefined)el.textContent=r.text;else{Preview.renderInlinePreview(el,r.text,r.index);Preview.wrapTaskText(el);el.querySelector('.jotdrop-task-text').dataset.previewTaskText='';el.querySelector('button').setAttribute('aria-label',r.text.slice(2));}
              return el;
            },expanded:()=>expanded,toggle:()=>expanded=!expanded,height:()=>innerHeight,more:'More',less:'Less',openLabel:n=>n?`Open note - ${n} more tasks`:'Open note',open:()=>{window.opened=name;}});
          };
        }""")
        for count in [0, 1, 5, 6, 10, 11, 100]:
            body = "# Title\n" + ("\n".join(f"- [{'x' if i % 2 else ' '}] task {i + 1}" for i in range(count)) or "Plain text")
            page.evaluate("([name,body])=>showPreview(name,body)", [str(count), body])
            card = page.locator(f'[data-name="{count}"]')
            host = card.locator(".jotdrop-card-preview")
            assert int(host.get_attribute("data-visible-tasks")) == min(count, 5)
            if count > 5:
                card.locator('[data-preview-action="toggle"]').click()
                assert int(host.get_attribute("data-visible-tasks")) == min(count, 10)
                if count >= 10:
                    assert card.locator('button[data-checklist-index="9"]').count() == 1
                card.locator('[data-preview-action="toggle"]').click()
                assert int(host.get_attribute("data-hidden-tasks")) == count - 5
        page.evaluate("body=>showPreview('article',body)", "# Title\n" + "Article sentence. " * 300 + "\n- [ ] A\n- [ ] B\n- [x] C")
        card = page.locator('[data-name="article"]')
        # A long introduction is clipped to half the preview so the tasks after it stay visible.
        assert card.locator("button[data-checklist-index]").count() == 3
        assert card.locator('[data-preview-action="toggle"]').count() == 0
        assert card.locator('[data-preview-action="open"]').inner_text() == "Open note"
        intro = card.locator(".jotdrop-card-preview").evaluate("el=>({text:el.querySelector('.jotdrop-preview-line')?.textContent||'',bottom:el.querySelector('.jotdrop-preview-line').getBoundingClientRect().bottom-el.getBoundingClientRect().top,cap:parseFloat(el.style.maxHeight)})")
        assert intro["text"].startswith("Article sentence.") and intro["text"].endswith("…"), intro
        assert intro["bottom"] <= intro["cap"] / 2 + 1, intro
        page.evaluate("body=>showPreview('article-many',body)", "# Title\n" + "Article sentence. " * 300 + "\n" + "\n".join(f"- [ ] M{i}" for i in range(12)))
        many = page.locator('[data-name="article-many"]')
        assert 2 <= many.locator("button[data-checklist-index]").count() <= 5
        assert many.locator('[data-preview-action="open"]').inner_text().endswith("more tasks")
        page.evaluate("body=>showPreview('tail',body)", "# Title\n- [ ] T1\n" + "Tail sentence. " * 300)
        tail = page.locator('[data-name="tail"]').locator(".jotdrop-card-preview")
        assert tail.evaluate("el=>el.querySelector('.jotdrop-preview-line').getBoundingClientRect().bottom-el.getBoundingClientRect().top > parseFloat(el.style.maxHeight)/2+1")
        shots = Path(tempfile.gettempdir()) / "kilo" / "compact-card-checks"
        shots.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(shots / "obsidian-desktop.png"), full_page=True)
        for width, height, size in [(390, 844, "16px"), (1200, 900, "32px"), (844, 390, "16px")]:
            page.set_viewport_size({"width": width, "height": height})
            page.locator("body").evaluate("(el,size)=>el.style.fontSize=size", size)
            page.wait_for_timeout(200)
            for host in page.locator(".jotdrop-card-preview").all():
                sizes = host.evaluate("el=>({h:el.offsetHeight,cap:parseFloat(el.style.maxHeight),rows:[...el.querySelectorAll('.jotdrop-preview-task')].map(r=>r.getBoundingClientRect().bottom-el.getBoundingClientRect().bottom)})")
                assert sizes["h"] <= sizes["cap"] + 1, sizes
                assert all(bottom <= 1 for bottom in sizes["rows"]), sizes
            if width == 390:
                page.screenshot(path=str(shots / "obsidian-mobile.png"), full_page=True)
        print("Obsidian synthetic DOM: 0/1/5/6/10/11/100, original indices, article, small viewport and 200% text PASS")
    finally:
        browser.close()
