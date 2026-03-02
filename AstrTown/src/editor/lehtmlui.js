import * as PIXI from 'pixi.js'
import { g_ctx }  from './lecontext.js' // global context
import * as CONFIG from './leconfig.js' 

// --
//  Set sizes and limits for HTML in main UI
// --

export function initMainHTMLWindow() {
    const paneIds = ['layer0pane', 'layer1pane', 'layer2pane', 'layer3pane'];
    for (const paneId of paneIds) {
        const pane = document.getElementById(paneId);
        if (!pane) {
            continue;
        }
        pane.style.maxWidth = `${CONFIG.htmlLayerPaneW}px`;
        pane.style.maxHeight = `${CONFIG.htmlLayerPaneH}px`;
    }

    const tilesetPane = document.getElementById('tilesetpane');
    if (tilesetPane) {
        tilesetPane.style.maxWidth = `${CONFIG.htmlTilesetPaneW}px`;
        tilesetPane.style.maxHeight = `${CONFIG.htmlTilesetPaneH}px`;
    }

    const compositePane = document.getElementById('compositepane');
    if (compositePane) {
        compositePane.style.maxWidth = '100%';
        compositePane.style.maxHeight = '100%';
    }

    const mapPane = document.getElementById('map');
    if (mapPane) {
        mapPane.style.display = 'none';
    }
}

// --
// Initialize handlers for file loading
// --





// --
// Initialize handlers loading a PNG file into the composite window 
// --

export function initCompositePNGLoader() {
    const fileInput = document.getElementById('compositepng');
    fileInput.onchange = (evt) => {
        if (!window.FileReader) return; // Browser is not compatible
        if (g_ctx.debug_flag) {
            console.log("compositepng ", fileInput.files[0].name);
        }
        let bgname = fileInput.files[0].name;

        const texture = PIXI.Texture.from("./tilesets/"+bgname);
        const bg      = new PIXI.Sprite(texture);
        bg.zIndex = 0;
        g_ctx.composite.container.addChild(bg);
    }
}

// -- 
// initailized handler to load a spriteSheet into current working tile
// --

export function initSpriteSheetLoader() {
    const fileInput = document.getElementById('spritesheet');
    fileInput.onchange = async (evt) => {
        if (!window.FileReader) return; // Browser is not compatible
        if (g_ctx.debug_flag) {
            console.log("spritesheet ", fileInput.files[0].name);
        }
        let ssname = fileInput.files[0].name;

        let sheet = await PIXI.Assets.load("./"+ssname);
        console.log(sheet);
        g_ctx.tileset.addTileSheet(ssname, sheet);
        g_ctx.selected_tiles = [];
    }
}

// -- 
// initailized handler to load a new tileset 
// --

export function initTilesetLoader(callme) {
    const fileInput = document.getElementById('tilesetfile');
    fileInput.onchange = async (evt) => {
        if (!window.FileReader) return; // Browser is not compatible
        if (g_ctx.debug_flag) {
            console.log("tilesetfile ", fileInput.files[0].name);
        }
        g_ctx.tilesetpath =  "./tilesets/"+fileInput.files[0].name;

        callme();
    }
}


// -- 
// initailized handler to load a level from a file 
// --

function doimport (str) {
    if (globalThis.URL.createObjectURL) {
      const blob = new Blob([str], { type: 'text/javascript' })
      const url = URL.createObjectURL(blob)
      const module = import(url)
      URL.revokeObjectURL(url) // GC objectURLs
      return module
    }
    
    const url = "data:text/javascript;base64," + btoa(moduleData)
    return import(url)
  }

export function initLevelLoader(callme) {
    let filecontent = "";

    const fileInput = document.getElementById('levelfile');
    fileInput.onchange = (evt) => {
        if (!window.FileReader) return; // Browser is not compatible

        var reader = new FileReader();

        reader.onload = function (evt) {
            if (evt.target.readyState != 2) return;
            if (evt.target.error) {
                alert('Error while reading file');
                return;
            }

            filecontent = evt.target.result;
            doimport(filecontent).then(mod => callme(mod));
        };

        reader.readAsText(evt.target.files[0]);
    }
}