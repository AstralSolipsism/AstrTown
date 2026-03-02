// --
// Simple level editer. 
//
// TODO:
//  -- right now if plaxing a sprite, will place based on selected tiles. So need to clear that when
//     loading a sprite
//  -- fix hardcoded animations, hack of putting spritesheet into g_ctx etc
//  -- create tab that contains all animations for a given json file 
//  -- add portals to level for character start positions
//  -- if you load an animated sprite and then load a level, it just puts the sprite everywhere
// 
// 
// Done:
//  -- fix level load bug where texture doesn't fit (load, mage, serene and then gentle)
//  -- write maps with sprites
//  - <esc> clear selected_tiles
//  - Delete tiles
//  - move magic numbers to context / initialization (zIndex, pane size etc.)
//  - todo fudge factor on g_ctx.tileset 
//  - get rid of dangerous CONFIG.tiledim (use g_ctx.tileDim instead)
//  - XXX create tilesetpadding for tilesets whos tiles are spaced (e.g. phantasy star II)
//  - only use fudge to pick sprites rather than fudge and non
//  - use g_ctx for g_ctx.tileset parameters instead of CONFIG (starting with initTilesetConfig) 
//  - todo print locations on screen
//
// 
// Keybindings:
// f - fill level 0 with current tile
// <ctl>-z - undo
// g - overlay 32x32 grid
// s - generate .js file to move over to convex/maps/
// m - place a semi-transparent red mask over all tiles. This helps find invisible tiles
// d - hold while clicking a tile to delete
// p - toggle between 16pixel and 32 pixel. 
// 
// Known bugs and annoyances
//  - if deleting a tile while filter is on, filter isn't refreshed so need to toggle with "m"
// --

import * as PIXI from 'pixi.js'
import { g_ctx }  from './lecontext.js' // global context
import * as CONFIG from './leconfig.js' 
import * as UNDO from './undo.js'
import * as MAPFILE from './mapfile.js'
import * as UI from './lehtmlui.js'
import { initSemanticUI } from './semanticui.js';
import '../../data/mapObjectCatalog.js';
import { EventSystem } from '@pixi/events';

g_ctx.debug_flag  = true;
g_ctx.debug_flag2 = false; // really verbose output

g_ctx.activeLayer = 0;
g_ctx.activeSidebarPanel = 'terrain';
g_ctx.editorMode = 'terrain';
g_ctx._workspaceUIBound = false;
g_ctx.compositeDragLayer = null;
g_ctx.compositeDragging = false;

const SIDEBAR_PANEL_TO_INSPECTOR = {
    terrain: 'panel-terrain',
    layers: 'panel-layers',
    'sem-objects': 'panel-sem-objects',
    'sem-zones': 'panel-sem-zones',
    files: 'panel-files',
};

const EDITOR_MODE_LABEL = {
    terrain: '地形绘制',
    object: '语义物体',
    zone: '语义区域',
};

const LAYER_LABEL = ['背景层0', '背景层1', '物件层0', '物件层1'];

function tileset_index_from_coords(x, y) {
    let retme = x + (y*g_ctx.tilesettilew);
    console.log("tileset_index_from_coord ",retme, x, y);
    return retme; 
}
function level_index_from_coords(x, y) {
    // place 16px tiles in separate index space
    let offset = (g_ctx.tiledimx == 16)? CONFIG.MAXTILEINDEX : 0;
    let retme = x + (y*CONFIG.leveltilewidth) + offset; 
    return retme;
}
function tileset_index_from_px(x, y) {
    let coord_x = Math.floor(x / (g_ctx.tiledimx + CONFIG.tilesetpadding));
    let coord_y = Math.floor(y / (g_ctx.tiledimx+ CONFIG.tilesetpadding));

    console.log("tileset_index_from_px ",x, y);

    return tileset_index_from_coords(coord_x, coord_y); 
}
function level_index_from_px(x, y) {
    let coord_x = Math.floor(x / g_ctx.tiledimx);
    let coord_y = Math.floor(y / g_ctx.tiledimx);
    return level_index_from_coords(coord_x, coord_y); 
}

function tileset_coords_from_index(index) {
        let x = index % (g_ctx.tilesettilew);
        let y = Math.floor(index / (g_ctx.tilesettilew));
        // console.log("tilesettilewidth: ",g_ctx.tilesettilew);
        // console.log("tileset_coords_from_index tile coords: ",index,x,y);
        return [x,y];
}

function tileset_px_from_index(index) {
        let ret = tileset_coords_from_index(index); 
        return [ret[0] * (g_ctx.tiledimx+CONFIG.tilesetpadding), ret[1] * (g_ctx.tiledimx+CONFIG.tilesetpadding)] ;
}


// return a sprite of size tileDim given (x,y) starting location
function sprite_from_px(x, y) {

    const bt = PIXI.BaseTexture.from(g_ctx.tilesetpath, {
        scaleMode: PIXI.SCALE_MODES.NEAREST,
    });
    let texture = new PIXI.Texture(bt,
                new PIXI.Rectangle(x, y, g_ctx.tiledimx, g_ctx.tiledimx),
            );
    return new PIXI.Sprite(texture);
}

function DragState() {
    this.square  = new PIXI.Graphics();
    this.tooltip = new PIXI.Text('', {
        fontFamily: 'Courier',
        fontSize: 12,
        fill: 0xffffff,
        align: 'center',
    });
    this.startx  = 0;
    this.starty = 0;
    this.endx   = 0;
    this.endy   = 0;
}

class LayerContext {

    constructor(app, pane, num, mod = null) {
        this.app = app;
        this.scrollpane = pane;
        this.num = num;
        this.widthpx  = CONFIG.levelwidth;
        this.heightpx = CONFIG.levelheight;


        this.container = new PIXI.Container();
        this.sprites = {};
        this.composite_sprites = {};
        this.dragctx = new DragState();

        app.stage.addChild(this.container);

        this.mouseshadow    = new PIXI.Container(); 
        this.mouseshadow.zIndex = CONFIG.zIndexMouseShadow; 

        this.lasttileindex  = -1;  // current tileset index
        this.curanimatedtile = null;

        this.fudgex = 0; // offset from 0,0
        this.fudgey = 0;

        this.square = new PIXI.Graphics();
        this.square.beginFill(0x2980b9);
        this.square.drawRect(0, 0, CONFIG.levelwidth, CONFIG.levelheight);
        this.square.endFill();
        this.square.eventMode = 'static';
        this.container.addChild(this.square);

        this.square.on('mousemove', onLevelMousemove.bind(this));
        this.square.on('mouseover', onLevelMouseover.bind(this));
        this.square.on('pointerout', onLevelMouseOut.bind(this))
        this.square.on('pointerdown', onLevelPointerDown.bind(null, this))
            .on('pointerup', onLevelDragEnd.bind(null, this))
            .on('pointerupoutside', onLevelDragEnd.bind(null, this));

        if (mod != null && !(mod  === g_ctx)) {
            this.loadFromMapFile(mod);
        }
    }

    loadFromMapFile(mod) {
        let tiles = [];
        if (this.num == 0) {
            tiles = mod.bgtiles[0];
        } else if (this.num == 1) {
            tiles = mod.bgtiles[1];
        } else if (this.num == 2) {
            tiles = mod.objmap[0];
        } else if (this.num == 3) {
            tiles = mod.objmap[1];
        } else {
            console.log("loadFromMapFile: Error unknow layer number");
            return;
        }

        for (let x = 0; x < tiles.length; x++) {
            for (let y = 0; y < tiles[0].length; y++) {
                if (tiles[x][y] != -1) {
                    this.addTileLevelCoords(x, y, mod.tiledim, tiles[x][y]);
                }
            }
        }
    }

    //  this will create a rectangle with an alpha channel for every square that has a sprite. This helps find 
    //  sprites that are purely transparent
    drawFilter() {

        if (typeof this.filtergraphics == 'undefined') {
            this.filtertoggle = true;
            this.filtergraphics = new PIXI.Graphics();
            this.filtergraphics.zIndex = CONFIG.zIndexFilter;
        }

        if (this.filtertoggle) {

            this.filtergraphics.beginFill(0xff0000, 0.3);
            for (let i in this.sprites) {
                let spr = this.sprites[i];
                this.filtergraphics.drawRect(spr.x, spr.y, g_ctx.tiledimx, g_ctx.tiledimx);
            }
            this.filtergraphics.endFill();
            this.container.addChild(this.filtergraphics);
        }else{
            this.filtergraphics.clear();
            this.container.removeChild(this.filtergraphics);
        }

        this.filtertoggle = ! this.filtertoggle;
    }

    // add tile of "index" to Level at location x,y
    addTileLevelCoords(x, y, dim, index) {
        return this.addTileLevelPx(x * dim, y * dim, index);
    }

    // add tile of tileset "index" to Level at location x,y
    addTileLevelPx(x, y, index) {

        if (x > CONFIG.levelwidth || y > CONFIG.levelheight){
            console.log("tile placed outside of level boundary, ignoring",x,y)
            return -1;
        } 

        let xPx = x;
        let yPx = y;

        let ctile = null;
        let ctile2 = null;

        if(g_ctx.spritesheet != null){
            ctile  =  new PIXI.AnimatedSprite(g_ctx.spritesheet.animations['row0']);
            ctile2 =  new PIXI.AnimatedSprite(g_ctx.spritesheet.animations['row0']);
            ctile.animationSpeed = .1;
            ctile2.animationSpeed = .1;
            ctile.autoUpdate = true;
            ctile2.autoUpdate = true;
            ctile.play();
            ctile2.play();

            // HACK for now just stuff animated sprite details into the sprite
            ctile.animationname   = 'row0';
            ctile.spritesheetname = g_ctx.spritesheetname; 

        } else {
            let pxloc = tileset_px_from_index(index);
            ctile = sprite_from_px(pxloc[0] + g_ctx.tileset.fudgex, pxloc[1] + g_ctx.tileset.fudgey);
            ctile.index = index;
            ctile2 = sprite_from_px(pxloc[0] + g_ctx.tileset.fudgex, pxloc[1] + g_ctx.tileset.fudgey);
        }

        // snap to grid
        const dx = g_ctx.tiledimx;
        const dy = g_ctx.tiledimy;
        ctile.x  = Math.floor(xPx / dx) * dx; 
        ctile2.x = Math.floor(xPx / dx) * dx; 
        ctile.y  = Math.floor(yPx / dy) * dy;
        ctile2.y = Math.floor(yPx / dy) * dy;
        ctile2.zIndex = this.num; 

        // console.log(xPx,yPx,ctile.x,ctile.y);

        let new_index = level_index_from_px(ctile.x, ctile.y);

        if(g_ctx.debug_flag2){
            console.log('addTileLevelPx ',this.num,' ctile.x ', ctile.x, 'ctile.y ', ctile.y, "index ", index, "new_index", new_index);
        }

        if (!g_ctx.dkey) {
            this.container.addChild(ctile);
            g_ctx.composite.container.addChild(ctile2);
        } 


        if (this.sprites.hasOwnProperty(new_index)) {
            if(g_ctx.debug_flag){
             console.log("addTileLevelPx: ",this.num,"removing old tile", new_index);
            }
            this.container.removeChild(this.sprites[new_index]);
            delete this.sprites[new_index];
            g_ctx.composite.container.removeChild(this.composite_sprites[new_index]);
            delete this.composite_sprites[new_index];
        }

        if (!g_ctx.dkey) {
            this.sprites[new_index] = ctile;
            this.composite_sprites[new_index] = ctile2;
        } else if (typeof this.filtergraphics != 'undefined') {
            this.filtergraphics.clear();
            this.drawFilter();
            this.drawFilter();
        }

        // consolelog("SETTING ZINDEX ", this.composite_sprites[new_index].zIndex);
        return new_index;
    }

} // class  LayerContext

class TilesetContext {

    constructor(app, mod = g_ctx) {
        this.app = app;
        this.container = new PIXI.Container();

        this.widthpx  = g_ctx.tilesetpxw;
        this.heightpx = g_ctx.tilesetpxh;
        console.log(mod.tilesetpath);
        const texture = PIXI.Texture.from(mod.tilesetpath);
        const bg    = new PIXI.Sprite(texture);

        this.square = new PIXI.Graphics();
        this.square.beginFill(0x2980b9);
        this.square.drawRect(0, 0, mod.tilesetpxw, mod.tilesetpxh);
        this.square.endFill();
        this.square.eventMode = 'static';
        this.container.addChild(this.square);
        this.container.addChild(bg);
        
        this.app.stage.addChild(this.container);

        this.fudgex = 0; // offset from 0,0
        this.fudgey = 0;

        this.dragctx = new DragState();

        this.square.on('mousedown', function (e) {

            // if a spritesheet has been loaded from a file, delete
            // FIXME, we should be able to add animated tiles to the 
            // tileset ... 
            if(g_ctx.spritesheet != null){
                // FIXME .. creating a leak here. But animatedsprites are still on the map so
                // cannot destroy. In the future these should be part of the UI 
                // g_ctx.spritesheet.destroy();
                g_ctx.spritesheet = null;
            }

            g_ctx.tile_index = tileset_index_from_px(e.global.x, e.global.y); 

            if(g_ctx.debug_flag) {
                console.log("g_ctx.tileset mouse down. index "+g_ctx.tile_index);
            }
        });

        this.square.on('pointerdown', onTilesetDragStart)
                .on('pointerup', onTilesetDragEnd)
                .on('pointerupoutside', onTilesetDragEnd);
    }

    addTileSheet(name, sheet){
        console.log(" tileset.addTileSheet ", sheet);


        // FIXME ... development code
        g_ctx.spritesheet = sheet;
        g_ctx.spritesheetname = name;

        let as =  new PIXI.AnimatedSprite(sheet.animations['row0']);
        as.animationSpeed = .1;
        as.autoUpdate = true;
        as.play();
        as.alpha = .5;
        g_ctx.g_layers[0].curanimatedtile = as;
    }
} // class TilesetContext


class CompositeContext {

    constructor(app) {
        this.app = app;
        this.widthpx  = CONFIG.levelwidth;
        this.heightpx = CONFIG.levelheight;

        this.container = new PIXI.Container();
        this.container.sortableChildren = true;
        this.app.stage.addChild(this.container);
        this.sprites = {};
        this.circle = new PIXI.Graphics();
        this.circle.zIndex = CONFIG.zIndexCompositePointer;

        this.fudgex = 0; // offset from 0,0
        this.fudgey = 0;

        this.mouseshadow    = new PIXI.Container(); 
        this.mouseshadow.zIndex = CONFIG.zIndexMouseShadow; 
        this.lasttileindex  = -1; 

        this.square = new PIXI.Graphics();
        this.square.beginFill(0x2980b9);
        this.square.drawRect(0, 0, CONFIG.levelwidth, CONFIG.levelheight);
        this.square.endFill();
        this.square.eventMode = 'static';
        this.container.addChild(this.square);

        this.square.on('mousedown', onCompositeMousedown.bind(null, this));
        this.square.on('pointerdown', onCompositePointerDown.bind(null, this));
        this.square.on('pointermove', onCompositePointerMove.bind(null, this));
        this.square.on('pointerup', onCompositePointerUp.bind(null, this));
        this.square.on('pointerupoutside', onCompositePointerUp.bind(null, this));
    }

} // class CompositeContext

function loadAnimatedSpritesFromModule(mod){

    if(!('animatedsprites' in mod) || mod.animatedsprites.length <= 0){
        return;
    }

    let m = new Map();

    for(let x = 0; x < mod.animatedsprites.length; x++){
        let spr = mod.animatedsprites[x];
        if(! m.has(spr.sheet)){
            m.set(spr.sheet, [spr]);
        }else{
            m.get(spr.sheet).push(spr);
        }
    }

    for(let key of m.keys()){
        console.log("loadAnimatedSpritesFromModule: ",key);
        PIXI.Assets.load("./"+key).then(
            function(sheet) {

                // setup global state so we can use layer addTileLevelMethod
                g_ctx.spritesheet     = sheet;
                g_ctx.spritesheetname = key;
                let asprarray = m.get(key);
                for (let asprite of asprarray) {
                    // TODO FIXME, pass in animation name
                    console.log("Loading animation", asprite.animation);
                    g_ctx.g_layers[asprite.layer].addTileLevelPx(asprite.x, asprite.y, -1);
                }
                g_ctx.spritesheet     = null;
                g_ctx.spritesheetname = null;
            }
        );
    }
}

function loadMapFromModuleFinish(mod) {
    const compositeSquare = g_ctx.composite?.square || null;

    g_ctx.composite.container.removeChildren();
    if (compositeSquare) {
        g_ctx.composite.container.addChildAt(compositeSquare, 0);
    }

    g_ctx.tileset_app.stage.removeChildren()
    g_ctx.tileset = new TilesetContext(g_ctx.tileset_app, mod);
    g_ctx.g_layer_apps[0].stage.removeChildren()
    g_ctx.g_layers[0] = new LayerContext(g_ctx.g_layer_apps[0], document.getElementById("layer0pane"), 0, mod);
    g_ctx.g_layer_apps[1].stage.removeChildren()
    g_ctx.g_layers[1] = new LayerContext(g_ctx.g_layer_apps[1], document.getElementById("layer1pane"), 1, mod);
    g_ctx.g_layer_apps[2].stage.removeChildren()
    g_ctx.g_layers[2] = new LayerContext(g_ctx.g_layer_apps[2], document.getElementById("layer2pane"), 2, mod);
    g_ctx.g_layer_apps[3].stage.removeChildren()
    g_ctx.g_layers[3] = new LayerContext(g_ctx.g_layer_apps[3], document.getElementById("layer3pane"), 3, mod);

    loadAnimatedSpritesFromModule(mod);

    if (g_ctx.semantic && typeof g_ctx.semantic.loadFromMapModule === 'function') {
        g_ctx.semantic.loadFromMapModule(mod);
    }
}

function loadMapFromModule(mod) {
    g_ctx.tilesetpath = mod.tilesetpath;
    initTilesSync(loadMapFromModuleFinish.bind(null, mod));
    initTiles();
}

function downloadpng(filename) {
    let newcontainer = new PIXI.Container();
    let children = [...g_ctx.composite.container.children];
    for(let i = 0; i <  children.length; i++) {
        let child = children[i];
        if (! child.hasOwnProperty('isSprite') || !child.isSprite){
            console.log(child);
            continue;
        }
        // console.log(child, typeof child);
        g_ctx.composite.container.removeChild(child);
        newcontainer.addChild(child);
    }

      const { renderer } = g_ctx.composite_app;
      renderer.plugins.extract.canvas(newcontainer).toBlob(function (b) {

      console.log(b);
      var a = document.createElement("a");
      document.body.append(a);
      a.download = filename;
      a.href = URL.createObjectURL(b);
      a.click();
      a.remove();
    }, "image/png");
  }

window.saveCompositeAsImage = () => {
    downloadpng("g_ctx.composite.png");
}

function updateStatusLayer() {
    const el = document.getElementById('status-layer');
    if (!el) {
        return;
    }
    const label = LAYER_LABEL[g_ctx.activeLayer] || ('图层' + g_ctx.activeLayer);
    el.textContent = '图层：' + label;
}

function updateStatusMode() {
    const el = document.getElementById('status-mode');
    if (!el) {
        return;
    }
    const label = EDITOR_MODE_LABEL[g_ctx.editorMode] || g_ctx.editorMode;
    el.textContent = '模式：' + label;
}

function updateStatusCoordFromGlobal(x, y) {
    const el = document.getElementById('status-coord');
    if (!el) {
        return;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        el.textContent = '坐标：-';
        return;
    }
    const tx = Math.floor(x / g_ctx.tiledimx);
    const ty = Math.floor(y / g_ctx.tiledimy);
    el.textContent = '坐标：(' + tx + ',' + ty + ')';
}

function setSemanticMode(enabled) {
    g_ctx.semanticMode = !!enabled;
    if (g_ctx.semantic && typeof g_ctx.semantic.setSemanticModeEnabled === 'function') {
        g_ctx.semantic.setSemanticModeEnabled(g_ctx.semanticMode);
    }
}

function setEditorMode(mode) {
    const nextMode = mode || 'terrain';
    g_ctx.editorMode = nextMode;

    if (g_ctx.semantic && typeof g_ctx.semantic.setEditorMode === 'function') {
        g_ctx.semantic.setEditorMode(nextMode);
        g_ctx.semanticMode = nextMode !== 'terrain';
    } else if (nextMode === 'terrain') {
        setSemanticMode(false);
    } else {
        setSemanticMode(true);
    }

    const modeButtons = document.querySelectorAll('.mode-btn');
    modeButtons.forEach((button) => {
        const active = button.dataset.mode === nextMode;
        button.classList.toggle('active', active);
        button.classList.toggle('is-active', active);
    });

    updateStatusMode();
}

function setActiveLayer(layerIndex) {
    const nextIndex = Number(layerIndex);
    if (!Number.isFinite(nextIndex) || nextIndex < 0 || nextIndex > 3) {
        return;
    }

    g_ctx.activeLayer = nextIndex;

    const layerButtons = document.querySelectorAll('.layer-btn');
    layerButtons.forEach((button) => {
        const active = Number(button.dataset.layer) === nextIndex;
        button.classList.toggle('active', active);
        button.classList.toggle('is-active', active);
    });

    updateStatusLayer();
}

function switchSidebarTab(panelName) {
    const panel = panelName || 'terrain';
    g_ctx.activeSidebarPanel = panel;

    const sidebarButtons = document.querySelectorAll('.sidebar-btn');
    sidebarButtons.forEach((button) => {
        const active = button.dataset.panel === panel;
        button.classList.toggle('active', active);
        button.classList.toggle('is-active', active);
    });

    const panels = document.querySelectorAll('.inspector-panel');
    panels.forEach((node) => node.classList.add('hidden'));

    const semanticHeader = document.getElementById('semantic-panel-header');
    if (semanticHeader) {
        semanticHeader.classList.add('hidden');
    }

    const targetId = SIDEBAR_PANEL_TO_INSPECTOR[panel];
    if (targetId) {
        const target = document.getElementById(targetId);
        if (target) {
            target.classList.remove('hidden');
        }
    }

    if (panel === 'sem-objects' || panel === 'sem-zones') {
        if (semanticHeader) {
            semanticHeader.classList.remove('hidden');
        }
    }

    if (panel === 'terrain' || panel === 'layers' || panel === 'files') {
        setEditorMode('terrain');
    } else if (panel === 'sem-objects') {
        setEditorMode('object');
    } else if (panel === 'sem-zones') {
        setEditorMode('zone');
    }
}

function bindWorkspaceUI() {
    if (g_ctx._workspaceUIBound) {
        return;
    }

    const sidebarButtons = document.querySelectorAll('.sidebar-btn');
    sidebarButtons.forEach((button) => {
        button.addEventListener('click', () => {
            switchSidebarTab(button.dataset.panel);
        });
    });

    const layerButtons = document.querySelectorAll('.layer-btn');
    layerButtons.forEach((button) => {
        button.addEventListener('click', () => {
            setActiveLayer(Number(button.dataset.layer));
        });
    });

    const modeButtons = document.querySelectorAll('.mode-btn');
    modeButtons.forEach((button) => {
        button.addEventListener('click', () => {
            setEditorMode(button.dataset.mode);
            if (button.dataset.mode === 'object') {
                switchSidebarTab('sem-objects');
            } else if (button.dataset.mode === 'zone') {
                switchSidebarTab('sem-zones');
            } else {
                switchSidebarTab('terrain');
            }
        });
    });

    const saveButton = document.getElementById('btn-save');
    if (saveButton) {
        saveButton.addEventListener('click', () => MAPFILE.generate_level_file());
    }

    const undoButton = document.getElementById('btn-undo');
    if (undoButton) {
        undoButton.addEventListener('click', () => {
            const event = new KeyboardEvent('keydown', { ctrlKey: true, code: 'KeyZ' });
            window.dispatchEvent(event);
        });
    }

    g_ctx._workspaceUIBound = true;

    setActiveLayer(g_ctx.activeLayer || 0);
    switchSidebarTab(g_ctx.activeSidebarPanel || 'terrain');
    updateStatusCoordFromGlobal(NaN, NaN);
}

// fill base level with currentIndex tile 
window.fill0 = () => {
    UNDO.undo_mark_task_start(g_ctx.g_layers[0]);
    for(let i = 0; i < CONFIG.levelwidth / g_ctx.tiledimx; i++){
        for(let j = 0; j < CONFIG.levelheight / g_ctx.tiledimx; j++){
            let ti = g_ctx.g_layers[0].addTileLevelCoords(i,j,g_ctx.tiledimx, g_ctx.tile_index);
            UNDO.undo_add_index_to_task(ti);
        }
    }
    UNDO.undo_mark_task_end();
}

window.addEventListener(
    "keyup", (event) => {
        if (event.code == "KeyD"){
            g_ctx.dkey = false;
            g_ctx.g_layers.map( (l) => l.container.addChild(l.mouseshadow));
            g_ctx.composite.container.addChild(g_ctx.composite.mouseshadow);
        }
    });
window.addEventListener(
    "keydown", (event) => {

        if (event.code == "KeyD"){
            g_ctx.dkey = true;
            g_ctx.g_layers.map((l) => l.container.removeChild(l.mouseshadow) );
            g_ctx.composite.container.removeChild(g_ctx.composite.mouseshadow);
        }

        if (event.code == 'KeyF'){
            window.fill0();
        }
        else if (event.code == 'KeyS'){
            MAPFILE.generate_level_file();
        }
        else if (event.code == 'Escape'){
            g_ctx.selected_tiles = [];
            g_ctx.g_layers.map((l) => l.mouseshadow.removeChildren());
            g_ctx.composite.mouseshadow.removeChildren();
        }
        else if (event.code == 'KeyM'){
            g_ctx.g_layers.map((l) => l.drawFilter () );
        }else if (event.code == 'KeyP'){
            setGridSize((g_ctx.tiledimx == 16)?32:16);
        }
        else if (event.code == 'KeyG'){
            g_ctx.g_layers.map((l) => redrawGrid (l, false) );
            redrawGrid(g_ctx.tileset, false); 
            redrawGrid(g_ctx.composite, false); 
        }
        else if (event.ctrlKey && event.code === 'KeyZ'){
            let undome = UNDO.undo_pop();
            if (!undome) {
                return;
            }
            let layer = undome.shift();
            for(let i = 0; i < undome.length; i++) {
                if (g_ctx.debug_flag) {
                    console.log("Undo removing ", undome[i])
                }
                // Remove current tile
                layer.container.removeChild(layer.sprites[undome[i][0]]);
                g_ctx.composite.container.removeChild(layer.composite_sprites[undome[i][0]]);
                
                // Restore original tile if it existed
                if (undome[i][1] !== -1) {
                    let pxloc = tileset_px_from_index(undome[i][1]);
                    let originalTile = sprite_from_px(pxloc[0] + g_ctx.tileset.fudgex, pxloc[1] + g_ctx.tileset.fudgey);
                    let originalTile2 = sprite_from_px(pxloc[0] + g_ctx.tileset.fudgex, pxloc[1] + g_ctx.tileset.fudgey);
                    
                    // Position tiles at the correct location
                    let x = Math.floor(undome[i][0] % CONFIG.leveltilewidth) * g_ctx.tiledimx;
                    let y = Math.floor(undome[i][0] / CONFIG.leveltilewidth) * g_ctx.tiledimx;
                    originalTile.x = x;
                    originalTile.y = y;
                    originalTile2.x = x;
                    originalTile2.y = y;
                    originalTile2.zIndex = layer.num;
                    
                    // Add tiles back to containers
                    layer.container.addChild(originalTile);
                    g_ctx.composite.container.addChild(originalTile2);
                    
                    // Update sprite references
                    layer.sprites[undome[i][0]] = originalTile;
                    layer.composite_sprites[undome[i][0]] = originalTile2;
                } else {
                    // If there was no original tile, delete the sprite references
                    delete layer.sprites[undome[i][0]];
                    delete layer.composite_sprites[undome[i][0]];
                }
            }
        }
        else if (event.shiftKey && event.code == 'ArrowUp') {
            g_ctx.tileset.fudgey -= 1;
            redrawGrid(g_ctx.tileset, true);
        }
        else if (event.shiftKey && event.code == 'ArrowDown') {
            g_ctx.tileset.fudgey += 1;
            redrawGrid(g_ctx.tileset, true);
        }
        else if (event.shiftKey && event.code == 'ArrowLeft') {
            g_ctx.tileset.fudgex -= 1;
            redrawGrid(g_ctx.tileset, true);
        }
        else if (event.shiftKey && event.code == 'ArrowRight') {
            g_ctx.tileset.fudgex += 1;
            redrawGrid(g_ctx.tileset, true);
        }
     }
  );

// Listen to pointermove on stage once handle is pressed.

function onTilesetDragStart(e)
{
    if (g_ctx.debug_flag) {
        console.log("onDragStartTileset()");
    }
    g_ctx.tileset.app.stage.eventMode = 'static';
    g_ctx.tileset.app.stage.addEventListener('pointermove', onTilesetDrag);
    
    g_ctx.tileset.dragctx.startx = e.data.global.x;
    g_ctx.tileset.dragctx.starty = e.data.global.y;
    g_ctx.tileset.dragctx.endx = e.data.global.x;
    g_ctx.tileset.dragctx.endy = e.data.global.y;

    g_ctx.tileset.app.stage.addChild(g_ctx.tileset.dragctx.square);
    // g_ctx.tileset.app.stage.addChild(g_ctx.tileset.dragctx.tooltip);

    g_ctx.selected_tiles = [];
}

// Stop dragging feedback once the handle is released.
function onTilesetDragEnd(e)
{
    if (g_ctx.debug_flag) {
        console.log("onDragEndTileset()");
    }

    g_ctx.tileset.app.stage.eventMode = 'auto';
    g_ctx.tileset.app.stage.removeEventListener('pointermove', onTilesetDrag);
    g_ctx.tileset.app.stage.removeChild(g_ctx.tileset.dragctx.square);
    g_ctx.tileset.app.stage.removeChild(g_ctx.tileset.dragctx.tooltip);


    if(g_ctx.tileset.dragctx.endx < g_ctx.tileset.dragctx.startx){
        let tmp = g_ctx.tileset.dragctx.endx;
        g_ctx.tileset.dragctx.endx = g_ctx.tileset.dragctx.startx;
        g_ctx.tileset.dragctx.startx = tmp;
    }
    if(g_ctx.tileset.dragctx.endy < g_ctx.tileset.dragctx.starty){
        let tmp = g_ctx.tileset.dragctx.endy;
        g_ctx.tileset.dragctx.endy = g_ctx.tileset.dragctx.starty;
        g_ctx.tileset.dragctx.starty = tmp;
    }

    let starttilex = Math.floor(g_ctx.tileset.dragctx.startx / g_ctx.tiledimx);
    let starttiley = Math.floor(g_ctx.tileset.dragctx.starty / g_ctx.tiledimx);
    let endtilex = Math.floor(g_ctx.tileset.dragctx.endx / g_ctx.tiledimx);
    let endtiley = Math.floor(g_ctx.tileset.dragctx.endy / g_ctx.tiledimx);

    if (g_ctx.debug_flag) {
        console.log("sx sy ex ey ", starttilex, ",", starttiley, ",", endtilex, ",", endtiley);
    }
    // let mouse clicked handle if there isn't a multiple tile square
    if(starttilex === endtilex && starttiley === endtiley ){
        return;
    }

//    g_ctx.tile_index = (starttiley * g_ctx.tilesettilew) + starttilex;

    g_ctx.tile_index = tileset_index_from_px(e.global.x, e.global.y); 

    let origx = starttilex;
    let origy = starttiley;
    for(let y = starttiley; y <= endtiley; y++){
        for(let x = starttilex; x <= endtilex; x++){
            let squareindex = (y * g_ctx.tilesettilew) + x;
            g_ctx.selected_tiles.push([x - origx,y - origy,squareindex]);
        }
    }
    g_ctx.tileset.dragctx.square.clear();
    // g_ctx.tileset.dragctx.tooltip.clear();
}

function onTilesetDrag(e)
{
    if (g_ctx.debug_flag) {
        console.log("onDragTileset()");
    }
    g_ctx.tileset.dragctx.endx = e.global.x;
    g_ctx.tileset.dragctx.endy = e.global.y;
    
    g_ctx.tileset.dragctx.square.clear();
    g_ctx.tileset.dragctx.square.beginFill(0xFF3300, 0.3);
    g_ctx.tileset.dragctx.square.lineStyle(2, 0xffd900, 1);
    g_ctx.tileset.dragctx.square.moveTo(g_ctx.tileset.dragctx.startx, g_ctx.tileset.dragctx.starty);
    g_ctx.tileset.dragctx.square.lineTo(g_ctx.tileset.dragctx.endx, g_ctx.tileset.dragctx.starty);
    g_ctx.tileset.dragctx.square.lineTo(g_ctx.tileset.dragctx.endx, g_ctx.tileset.dragctx.endy);
    g_ctx.tileset.dragctx.square.lineTo(g_ctx.tileset.dragctx.startx, g_ctx.tileset.dragctx.endy);
    g_ctx.tileset.dragctx.square.closePath();
    g_ctx.tileset.dragctx.square.endFill();


    // g_ctx.tileset.dragctx.tooltip.clear();
    // g_ctx.tileset.dragctx.tooltip.beginFill(0xFF3300, 0.3);
    // g_ctx.tileset.dragctx.tooltip.lineStyle(2, 0xffd900, 1);
    // g_ctx.tileset.dragctx.tooltip.drawRect(e.global.x, e.global.y, 20,8);
    // g_ctx.tileset.dragctx.tooltip.endFill();
}

//g_ctx.tileset.app.stage.addChild(g_ctx.tileset.container);

function redrawGrid(pane, redraw = false) {

    if (typeof pane.gridtoggle == 'undefined') {
        // first time we're being called, initialized
        pane.gridtoggle  = false;
        pane.gridvisible = false;
        redraw = true;
        pane.gridvisible = true;
    }

    if (redraw) {
        if (typeof pane.gridgraphics != 'undefined') {
            pane.container.removeChild(pane.gridgraphics);
        }

        pane.gridgraphics = new PIXI.Graphics();
        let gridsizex = g_ctx.tiledimx;
        let gridsizey = g_ctx.tiledimy;
        pane.gridgraphics.lineStyle(1, 0x000000, 1);


        let index = 0;
        for (let i = 0; i < pane.widthpx; i += gridsizex) {
            pane.gridgraphics.moveTo(i + pane.fudgex, 0 + pane.fudgey);
            pane.gridgraphics.lineTo(i + pane.fudgex, pane.heightpx + pane.fudgey);
            pane.gridgraphics.moveTo(i + gridsizex + pane.fudgex, 0 + pane.fudgey);
            pane.gridgraphics.lineTo(i + gridsizex + pane.fudgex, pane.heightpx + pane.fudgey);

        }
        for (let j = 0; j < pane.heightpx; j += gridsizey) {
            pane.gridgraphics.moveTo(0 + pane.fudgex, j + gridsizey + pane.fudgey);
            pane.gridgraphics.lineTo(pane.widthpx + pane.fudgex, j + gridsizey + pane.fudgey);
            pane.gridgraphics.moveTo(0 + pane.fudgex, j + pane.fudgey);
            pane.gridgraphics.lineTo(pane.heightpx + pane.fudgex, j + pane.fudgey);
        }

        if(pane.gridvisible){
            pane.container.addChild(pane.gridgraphics);
        }
        return;
    }

    if (pane.gridtoggle) {
        pane.container.addChild(pane.gridgraphics);
        pane.gridvisible = true;
    }else{
        pane.container.removeChild(pane.gridgraphics);
        pane.gridvisible = false;
    }

    pane.gridtoggle = !pane.gridtoggle;
}


// --
// Variable placement logic Level1
// --

function centerCompositePane(x, y){
    const compositepane = document.getElementById("compositepane");
    if (!compositepane) {
        return;
    }
    compositepane.scrollLeft = x - (compositepane.clientWidth / 2);
    compositepane.scrollTop = y - (compositepane.clientHeight / 2);
}

function getOldTileValue(layer, x, y) {
    let levelIndex = level_index_from_px(x, y);
    return layer.sprites[levelIndex] ? layer.sprites[levelIndex].index : -1;
}

function centerLayerPanes(x, y){
    const compositePane = document.getElementById('compositepane');
    if (!compositePane) {
        return;
    }

    compositePane.scrollLeft = x - (compositePane.clientWidth / 2);
    compositePane.scrollTop = y - (compositePane.clientHeight / 2);
}

function onLevelMouseover(e) {
    let x = e.data.global.x;
    let y = e.data.global.y;
    if(g_ctx.debug_flag2){
        console.log("onLevelMouseOver ",this.num);
    }
    if (x < this.scrollpane.scrollLeft || x > this.scrollpane.scrollLeft + CONFIG.htmlCompositePaneW) {
        return;
    }
    if (y < this.scrollpane.scrollTop || y > this.scrollpane.scrollTop + CONFIG.htmlCompositePaneH) {
        return;
    }

    // FIXME test code
    if ( g_ctx.spritesheet != null){
        let ctile  =  new PIXI.AnimatedSprite(g_ctx.spritesheet.animations['row0']);
        let ctile2 =  new PIXI.AnimatedSprite(g_ctx.spritesheet.animations['row0']);
        ctile.animationSpeed = .1;
        ctile2.animationSpeed = .1;
        ctile.autoUpdate = true;
        ctile2.autoUpdate = true;
        ctile.alpha = .5;
        ctile2.alpha = .5;
        ctile.play();
        ctile2.play();

        this.mouseshadow.addChild(ctile);
        g_ctx.composite.mouseshadow.addChild(ctile2);
    // FIXME test code
    }
    else if (this.lasttileindex != g_ctx.tile_index) {
        this.mouseshadow.removeChildren(0);
        g_ctx.composite.mouseshadow.removeChildren(0);
        if (g_ctx.selected_tiles.length == 0) {
            let shadowsprite = null;
            let shadowsprite2 = null;

            let pxloc = tileset_px_from_index(g_ctx.tile_index);

            shadowsprite  = sprite_from_px(pxloc[0] + g_ctx.tileset.fudgex, pxloc[1] + g_ctx.tileset.fudgey);
            shadowsprite2 = sprite_from_px(pxloc[0] + g_ctx.tileset.fudgex, pxloc[1] + g_ctx.tileset.fudgey);

            shadowsprite.alpha = .5;
            shadowsprite2.alpha = .5;
            this.mouseshadow.addChild(shadowsprite);
            g_ctx.composite.mouseshadow.addChild(shadowsprite2);
        } else {
            // TODO! adjust for fudge
            for (let i = 0; i < g_ctx.selected_tiles.length; i++) {
                let tile = g_ctx.selected_tiles[i];
                let pxloc = tileset_px_from_index(tile[2]);

                const shadowsprite  = sprite_from_px(pxloc[0] + g_ctx.tileset.fudgex, pxloc[1] + g_ctx.tileset.fudgey);
                const shadowsprite2 = sprite_from_px(pxloc[0] + g_ctx.tileset.fudgex, pxloc[1] + g_ctx.tileset.fudgey);
                shadowsprite.x = tile[0] * g_ctx.tiledimx;
                shadowsprite.y = tile[1] * g_ctx.tiledimx;
                shadowsprite2.x = tile[0] * g_ctx.tiledimx;
                shadowsprite2.y = tile[1] * g_ctx.tiledimx;
                shadowsprite.alpha = .5;
                shadowsprite2.alpha = .5;
                this.mouseshadow.addChild(shadowsprite);
                g_ctx.composite.mouseshadow.addChild(shadowsprite2);
            }

        }
        this.mouseshadow.x = x - 16;
        this.mouseshadow.y = y - 16;
        this.container.removeChild(this.mouseshadow);
        g_ctx.composite.container.removeChild(g_ctx.composite.mouseshadow);
        this.container.addChild(this.mouseshadow);
        g_ctx.composite.container.addChild(g_ctx.composite.mouseshadow);
    }

    g_ctx.composite.app.stage.removeChild(g_ctx.composite.circle);
    g_ctx.composite.app.stage.addChild(g_ctx.composite.circle);
}


function onLevelMouseOut(e) {
    if (g_ctx.debug_flag2) {
        console.log("onLevelMouseOut ",this.num);
    }

    //FIXME there is a funky race condition where the mouse enters a second layer before leaving the last and the following line
    //deletes the composite mouseshadow. I'm not quite sure how to solve without mapping the composite.mouseshadow to each layer

    this.mouseshadow.removeChildren(0);
    g_ctx.composite.mouseshadow.removeChildren();
}

function onLevelMousemove(e) {
    let x = e.data.global.x;
    let y = e.data.global.y;

    // FIXME TEST CODE
    this.mouseshadow.x = x-8;
    this.mouseshadow.y = y-8;
    g_ctx.composite.mouseshadow.x = x-8;
    g_ctx.composite.mouseshadow.y = y-8;
    // FIXME TEST CODE


    if (x < this.scrollpane.scrollLeft || x > this.scrollpane.scrollLeft + CONFIG.htmlCompositePaneW) {
        return;
    }
    if (y < this.scrollpane.scrollTop || y > this.scrollpane.scrollTop + CONFIG.htmlCompositePaneH) {
        return;
    }

    g_ctx.composite.circle.clear();
    g_ctx.composite.circle.beginFill(0xe50000, 0.5);
    g_ctx.composite.circle.drawCircle(e.data.global.x, e.data.global.y, 3);
    g_ctx.composite.circle.endFill();
}
function onCompositeMousedown(layer, e) {
    if (g_ctx.debug_flag) {
        console.log('onCompositeMouseDown: X', e.data.global.x, 'Y', e.data.global.y);
    }

    const xorig = e.data.global.x;
    const yorig = e.data.global.y;
    updateStatusCoordFromGlobal(xorig, yorig);

    const compositePane = document.getElementById('compositepane');
    if (!compositePane) {
        return;
    }

    // 单视口模式下保持点击点在视口中心附近
    compositePane.scrollLeft = xorig - (compositePane.clientWidth / 2);
    compositePane.scrollTop = yorig - (compositePane.clientHeight / 2);
}

function getActiveLayer() {
    const layer = g_ctx.g_layers[g_ctx.activeLayer];
    return layer || null;
}

function onCompositePointerDown(compositeCtx, e) {
    updateStatusCoordFromGlobal(e.data.global.x, e.data.global.y);

    if (g_ctx.editorMode !== 'terrain' || isSemanticPlacementEnabled()) {
        return;
    }

    const layer = getActiveLayer();
    if (!layer) {
        return;
    }

    g_ctx.compositeDragLayer = layer;
    g_ctx.compositeDragging = true;
    onLevelPointerDown(layer, e);
}

function onCompositePointerMove(compositeCtx, e) {
    updateStatusCoordFromGlobal(e.data.global.x, e.data.global.y);

    if (!g_ctx.compositeDragging || !g_ctx.compositeDragLayer) {
        return;
    }

    onLevelDrag(g_ctx.compositeDragLayer, e);
}

function onCompositePointerUp(compositeCtx, e) {
    updateStatusCoordFromGlobal(e.data.global.x, e.data.global.y);

    if (!g_ctx.compositeDragging || !g_ctx.compositeDragLayer) {
        return;
    }

    onLevelDragEnd(g_ctx.compositeDragLayer, e);
    g_ctx.compositeDragging = false;
    g_ctx.compositeDragLayer = null;
}

function isSemanticPlacementEnabled() {
    return g_ctx.semanticMode === true;
}

// Place with no variable target at destination
function levelPlaceNoVariable(layer, e) {
    if (g_ctx.debug_flag) {
        console.log('levelPlaceNoVariable: X', e.data.global.x, 'Y', e.data.global.y);
    }

    let xorig = e.data.global.x;
    let yorig = e.data.global.y;

    centerCompositePane(xorig, yorig);

    if (g_ctx.dkey || g_ctx.selected_tiles.length == 0) {
        let oldValue = getOldTileValue(layer, e.data.global.x, e.data.global.y);
        let ti = layer.addTileLevelPx(e.data.global.x, e.data.global.y, g_ctx.tile_index);
        UNDO.undo_add_single_index_as_task(layer, ti, oldValue);
    } else {
        UNDO.undo_mark_task_start(layer);
        for (let index of g_ctx.selected_tiles) {
            // Calculate position and get old value
            let x = xorig + index[0] * g_ctx.tiledimx;
            let y = yorig + index[1] * g_ctx.tiledimx;
            let oldValue = getOldTileValue(layer, x, y);
            
            let ti = layer.addTileLevelPx(x, y, index[2]);
            UNDO.undo_add_index_to_task(ti, oldValue);
        }
        UNDO.undo_mark_task_end();
    }
}

// Listen to pointermove on stage once handle is pressed.
function onLevelPointerDown(layer, e)
{
    if (isSemanticPlacementEnabled()) {
        return;
    }
    if (g_ctx.debug_flag) {
        console.log("onLevelPointerDown()");
    }
    layer.app.stage.eventMode = 'static';
    if (!layer._boundDragHandler) {
        layer._boundDragHandler = onLevelDrag.bind(null, layer);
    }
    layer.app.stage.addEventListener('pointermove', layer._boundDragHandler);

    layer.container.removeChild(layer.mouseshadow);
    g_ctx.composite.container.removeChild(g_ctx.composite.mouseshadow);

    layer.dragctx.startx = e.data.global.x;
    layer.dragctx.starty = e.data.global.y;
    layer.dragctx.endx = e.data.global.x;
    layer.dragctx.endy = e.data.global.y;

    const dragOverlayStage = g_ctx.composite_app?.stage || layer.app.stage;
    dragOverlayStage.addChild(layer.dragctx.square);
    dragOverlayStage.addChild(layer.dragctx.tooltip);
}

function onLevelDrag(layer, e)
{
    if(layer.dragctx.startx == -1){
        layer.dragctx.square.clear();
        return;
    }

    layer.dragctx.endx = e.global.x;
    layer.dragctx.endy = e.global.y;

    if (g_ctx.debug_flag) {
        console.log("onLevelDrag()");
    }
    
    layer.dragctx.square.clear();
    layer.dragctx.square.beginFill(0xFF3300, 0.3);
    layer.dragctx.square.lineStyle(2, 0xffd900, 1);
    layer.dragctx.square.moveTo(layer.dragctx.startx, layer.dragctx.starty);
    layer.dragctx.square.lineTo(layer.dragctx.endx, layer.dragctx.starty);
    layer.dragctx.square.lineTo(layer.dragctx.endx, layer.dragctx.endy);
    layer.dragctx.square.lineTo(layer.dragctx.startx, layer.dragctx.endy);
    layer.dragctx.square.closePath();
    layer.dragctx.square.endFill();

    const vwidth  = Math.floor((layer.dragctx.endx - layer.dragctx.startx)/g_ctx.tiledimx);
    const vheight = Math.floor((layer.dragctx.endy - layer.dragctx.starty)/g_ctx.tiledimx);
    layer.dragctx.tooltip.x = e.global.x + 16;
    layer.dragctx.tooltip.y = e.global.y - 4;
    layer.dragctx.tooltip.text = "["+vwidth+","+vheight+"]\n"+
                                 "("+Math.floor(e.global.x/g_ctx.tiledimx)+","+Math.floor(e.global.y/g_ctx.tiledimx)+")";
    //layer.dragctx.tooltip.text = "("+e.global.x+","+e.global.y+")";
}

// Stop dragging feedback once the handle is released.
function onLevelDragEnd(layer, e)
{
    if (isSemanticPlacementEnabled()) {
        return;
    }
    layer.dragctx.endx = e.data.global.x;
    layer.dragctx.endy = e.data.global.y;

    if(layer.dragctx.startx == -1){
        console.log("onLevelDragEnd() start is -1 bailing");
        return;
    }
    if (g_ctx.debug_flag) {
        console.log("onLevelDragEnd()");
    }

    if(layer.dragctx.endx < layer.dragctx.startx){
        let tmp = layer.dragctx.endx;
        layer.dragctx.endx = layer.dragctx.startx;
        layer.dragctx.startx = tmp;
    }
    if(layer.dragctx.endy < layer.dragctx.starty){
        let tmp = layer.dragctx.endy;
        layer.dragctx.endy = layer.dragctx.starty;
        layer.dragctx.starty = tmp;
    }

    //FIXME TEST CODE show mouseshadow again once done draggin
    layer.container.addChild(layer.mouseshadow);
    g_ctx.composite.container.addChild(g_ctx.composite.mouseshadow);

    layer.app.stage.eventMode = 'auto';
    if (layer._boundDragHandler) {
        layer.app.stage.removeEventListener('pointermove', layer._boundDragHandler);
    }
    if (layer.dragctx.square.parent) {
        layer.dragctx.square.parent.removeChild(layer.dragctx.square);
    }
    if (layer.dragctx.tooltip.parent) {
        layer.dragctx.tooltip.parent.removeChild(layer.dragctx.tooltip);
    }

    let starttilex = Math.floor(layer.dragctx.startx / g_ctx.tiledimx);
    let starttiley = Math.floor(layer.dragctx.starty / g_ctx.tiledimx);
    let endtilex = Math.floor(layer.dragctx.endx / g_ctx.tiledimx);
    let endtiley = Math.floor(layer.dragctx.endy / g_ctx.tiledimx);

    if (g_ctx.debug_flag) {
        console.log("sx ", starttilex, " ex ", endtilex);
        console.log("sy ", starttiley, " ey ", endtiley);
    }

    // no variable placement. 
    if(starttilex === endtilex && starttiley == endtiley ){
        levelPlaceNoVariable(layer, e);
        layer.dragctx.startx = -1;
        layer.dragctx.endx    = -1;
        layer.dragctx.starty = -1;
        layer.dragctx.endy    = -1;
        return;
    }

    if (g_ctx.selected_tiles.length == 0) {
        UNDO.undo_mark_task_start(layer);
        for (let i = starttilex; i <= endtilex; i++) {
            for (let j = starttiley; j <= endtiley; j++) {
                let x = i * g_ctx.tiledimx;
                let y = j * g_ctx.tiledimx;
                let oldValue = getOldTileValue(layer, x, y);
                let ti = layer.addTileLevelPx(x, y, g_ctx.tile_index);
                UNDO.undo_add_index_to_task(ti, oldValue);
            }
        }
        UNDO.undo_mark_task_end();
    } else {
        // figure out selected grid
        let selected_grid = Array.from(Array(64), () => new Array(64)); // FIXME ... hope 64x64 is enough
        let row = 0;
        let column = 0;
        let selected_row = g_ctx.selected_tiles[0][1];
        // selected_grid[0] = [];
        for (let index of g_ctx.selected_tiles) {
            // console.log("Selected row ", selected_row, index);
            if(index[1] != selected_row){
                selected_row = index[1];
                row++;
                column = 0;
                //selected_grid[row] = [];
            }
            selected_grid[column++][row]  = index;
        }
        // at this point should have a 3D array of the selected tiles and the size should be row, column

        UNDO.undo_mark_task_start(layer);

        let ti=0;
        for (let i = starttilex; i <= endtilex; i++) {
            for (let j = starttiley; j <= endtiley; j++) {
                // Get the old value before placing new tile
                let x = i * g_ctx.tiledimx;
                let y = j * g_ctx.tiledimx;
                let oldValue = getOldTileValue(layer, x, y);

                if (j === starttiley) { // first row 
                    if (i === starttilex) { // top left corner
                        ti = layer.addTileLevelPx(x, y, selected_grid[0][0][2]);
                    }
                    else if (i == endtilex) { // top right corner
                        ti = layer.addTileLevelPx(x, y, selected_grid[column - 1][0][2]);
                    } else { // top middle
                        ti = layer.addTileLevelPx(x, y, selected_grid[1][0][2]);
                    }
                } else if (j === endtiley) { // last row
                    if (i === starttilex) { // bottom left corner
                        ti = layer.addTileLevelPx(x, y, selected_grid[0][row][2]);
                    }
                    else if (i == endtilex) { // bottom right corner
                        ti = layer.addTileLevelPx(x, y, selected_grid[column - 1][row][2]);
                    } else { // bottom middle
                        ti = layer.addTileLevelPx(x, y, selected_grid[1][row][2]);
                    }
                } else { // middle row
                    if (i === starttilex) { // middle left 
                        ti = layer.addTileLevelPx(x, y, selected_grid[0][(row > 0)? 1 : 0][2]);
                    }
                    else if (i === endtilex) { // middle end 
                        ti = layer.addTileLevelPx(x, y, selected_grid[column - 1][(row > 0)? 1 : 0][2]);
                    } else { // middle middle
                        ti = layer.addTileLevelPx(x, y, selected_grid[1][(row > 0)? 1 : 0][2]);
                    }
                }
                UNDO.undo_add_index_to_task(ti, oldValue);
            }
        }
        UNDO.undo_mark_task_end();
    }

    layer.dragctx.square.clear();

    layer.dragctx.startx = -1;
    layer.dragctx.starty = -1;
}



// --
// Initialized all pixi apps / components for application
// --
function initPixiApps() {

    // -- Editor wide globals --

    // First layer of level
    const level_app0 = new PIXI.Application({ backgroundColor: 0x2980b9, width: CONFIG.levelwidth, height: CONFIG.levelheight, view: document.getElementById('level0') });
    let layer0 = new LayerContext(level_app0, document.getElementById("layer0pane"), 0);

    // second layer of level 
    const level_app1 = new PIXI.Application({ backgroundColor: 0x2980b9, width: CONFIG.levelwidth, height: CONFIG.levelheight, view: document.getElementById('level1') });
    let layer1 = new LayerContext(level_app1, document.getElementById("layer1pane"), 1);

    //  object layer of level
    const level_app2 = new PIXI.Application({ backgroundColor: 0x2980b9, width: CONFIG.levelwidth, height: CONFIG.levelheight, view: document.getElementById('level3') });
    let layer2 = new LayerContext(level_app2, document.getElementById("layer2pane"), 2);

    //  object layer of level
    const level_app3 = new PIXI.Application({ backgroundColor: 0x2980b9, width: CONFIG.levelwidth, height: CONFIG.levelheight, view: document.getElementById('level4') });

    let layer3 = new LayerContext(level_app3, document.getElementById("layer3pane"), 3);

    g_ctx.g_layer_apps = [];
    g_ctx.g_layer_apps.push(level_app0 );
    g_ctx.g_layer_apps.push(level_app1);
    g_ctx.g_layer_apps.push(level_app2);
    g_ctx.g_layer_apps.push(level_app3);


    g_ctx.g_layers = [];
    g_ctx.g_layers.push(layer0);
    g_ctx.g_layers.push(layer1);
    g_ctx.g_layers.push(layer2);
    g_ctx.g_layers.push(layer3);

    // g_ctx.composite view 
    g_ctx.composite_app = new PIXI.Application({ backgroundAlpha: 0, width: CONFIG.levelwidth, height: CONFIG.levelheight, view: document.getElementById('composite') });
    g_ctx.composite = new CompositeContext(g_ctx.composite_app);

    //  map tab 
    g_ctx.map_app = new PIXI.Application({ backgroundColor: 0x2980b9, width: CONFIG.levelwidth, height: CONFIG.levelheight, view: document.getElementById('mapcanvas') });

    // g_ctx.tileset
    g_ctx.tileset_app = new PIXI.Application({ width: 5632 , height: 8672, view: document.getElementById('tileset') });
    //g_ctx.tileset_app = new PIXI.Application({ width: g_ctx.tilesetpxw, height: g_ctx.tilesetpxh, view: document.getElementById('tileset') });
    // const { renderer } = g_ctx.tileset_app;
    // // Install the EventSystem
    // renderer.addSystem(EventSystem, 'tileevents');
    g_ctx.tileset = new TilesetContext(g_ctx.tileset_app);
}

function setGridSize(size) {
    if (size == 16) {
        if (g_ctx.tiledimx == 16) { return; }
        g_ctx.tilesettilew = (g_ctx.tilesettilew/ (size / g_ctx.tiledimx));
        g_ctx.tilesettileh = (g_ctx.tilesettileh / (size / g_ctx.tiledimy));
        g_ctx.tiledimx = 16;
        g_ctx.tiledimy = 16;
        g_ctx.curtiles = g_ctx.tiles16;
        console.log("set to curTiles16");
    } else if (size == 32) {
        if (g_ctx.tiledimx == 32) { return; }
        g_ctx.tilesettilew = (g_ctx.tilesettilew/ (size / g_ctx.tiledimx));
        g_ctx.tilesettileh = (g_ctx.tilesettileh / (size / g_ctx.tiledimy));
        g_ctx.tiledimx = 32;
        g_ctx.tiledimy = 32;
        g_ctx.curtiles = g_ctx.tiles32;
        console.log("set to curTiles32");
    } else {
        console.debug("Invalid TileDim!");
        return;
    }
    g_ctx.g_layers.map((l) => redrawGrid (l, true) );
    redrawGrid(g_ctx.tileset, true);
    redrawGrid(g_ctx.composite, true);
}

function initRadios() {
    var rad = document.myForm.radioTiledim;
    var prev = null;
    for (var i = 0; i < rad.length; i++) {
        rad[i].addEventListener('change', function () {
            if (this !== prev) {
                prev = this;
            }
            setGridSize(this.value);
        });
    }
}

// --
// Load in default tileset and use to set properties
// --

function initTilesSync(callme) {
    return new Promise((resolve, reject) => {

        console.log("initTileSync");
        const texture = new PIXI.BaseTexture(g_ctx.tilesetpath);
        if(texture.valid) {
            console.log("BaseTexture already valid");
            callme();
            return;
        }

        console.log("Loading texture ", g_ctx.tilesetpath);
        texture.on('loaded', function () {
            // size of g_ctx.tileset in px
            g_ctx.tilesetpxw = texture.width;
            g_ctx.tilesetpxh = texture.height;
            console.log("Texture size w:", g_ctx.tilesetpxw, "h:", g_ctx.tilesetpxh);
            // size of g_ctx.tileset in tiles
            let tileandpad = g_ctx.tiledimx + CONFIG.tilesetpadding;
            let numtilesandpadw = Math.floor(g_ctx.tilesetpxw / tileandpad);
            g_ctx.tilesettilew = numtilesandpadw + Math.floor((g_ctx.tilesetpxw - (numtilesandpadw * tileandpad)) / g_ctx.tiledimx);
            let numtilesandpadh = Math.floor(g_ctx.tilesetpxh / tileandpad);
            g_ctx.tilesettileh = numtilesandpadh + Math.floor((g_ctx.tilesetpxh - (numtilesandpadh * tileandpad)) / g_ctx.tiledimx);
            console.log("Number of x tiles ", g_ctx.tilesettilew, " y tiles ", g_ctx.tilesettileh);
            g_ctx.MAXTILEINDEX = g_ctx.tilesettilew * g_ctx.tilesettileh;

            texture.destroy();
            resolve();
            callme();
        });

    });
}

// --
// Load default Tileset
// --

const initTilesConfig = async () => {

    g_ctx.tilesetpath = CONFIG.DEFAULTTILESETPATH;

    return new Promise((resolve, reject) => {
        
    const texture = new PIXI.BaseTexture(g_ctx.tilesetpath);
    if (g_ctx.debug_flag) {
        console.log("initTilessConfi: Loading texture ",g_ctx.tilesetpath);
    }
    texture .on('loaded', function() {
        // size of g_ctx.tileset in px
        g_ctx.tilesetpxw = texture.width;
        g_ctx.tilesetpxh = texture.height;
        if (g_ctx.debug_flag) {
            console.log("\tsize w:", g_ctx.tilesetpxw, "h:", g_ctx.tilesetpxh);
        }

        // size of g_ctx.tileset in tiles
        let tileandpad = g_ctx.tiledimx + CONFIG.tilesetpadding;
        let numtilesandpadw = Math.floor(g_ctx.tilesetpxw / tileandpad);
        g_ctx.tilesettilew = numtilesandpadw + Math.floor((g_ctx.tilesetpxw - (numtilesandpadw * tileandpad))/g_ctx.tiledimx);
        let numtilesandpadh = Math.floor(g_ctx.tilesetpxh / tileandpad);
        g_ctx.tilesettileh = numtilesandpadh + Math.floor((g_ctx.tilesetpxh - (numtilesandpadh * tileandpad))/g_ctx.tiledimx);

        if (g_ctx.debug_flag) {
            console.log("\tnum tiles x ", g_ctx.tilesettilew, " y ", g_ctx.tilesettileh);
        }

        g_ctx.MAXTILEINDEX = g_ctx.tilesettilew * g_ctx.tilesettileh;

        texture.destroy();
        resolve();
    });

  
      });
  };

function initTiles() {
    // load g_ctx.tileset into a global array of textures for blitting onto levels
    const bt = PIXI.BaseTexture.from(g_ctx.tilesetpath, {
        scaleMode: PIXI.SCALE_MODES.NEAREST,
    });
    for (let x = 0; x < CONFIG.tilesettilewidth; x++) {
        for (let y = 0; y < CONFIG.tilesettileheight; y++) {
            g_ctx.tiles32[x + y * CONFIG.tilesettilewidth] = new PIXI.Texture(
                bt,
                new PIXI.Rectangle(x * 32, y * 32, 32, 32),
            );
        }
    }
    for (let x = 0; x < CONFIG.tilesettilewidth * 2; x++) {
        for (let y = 0; y < CONFIG.tilesettileheight * 2; y++) {
            g_ctx.tiles16[x + y * CONFIG.tilesettilewidth * 2] = new PIXI.Texture(
                bt,
                new PIXI.Rectangle(x * 16, y * 16, 16, 16),
            );
        }
    }

    g_ctx.curtiles = g_ctx.tiles32;
}

async function init() {

    UI.initMainHTMLWindow();

    // We need to load the Tileset to know how to size things. So we block until done.
    await initTilesConfig();

    initPixiApps();
    initRadios();
    initTiles();

    g_ctx.semantic = await initSemanticUI(g_ctx, {
        onSwitchSidebarTab: switchSidebarTab,
    });

    setEditorMode('terrain');

    window.addEventListener('keydown', (event) => {
        if (event.code === 'KeyV') {
            const nextMode = g_ctx.semanticMode ? 'terrain' : 'object';
            setEditorMode(nextMode);
            if (nextMode === 'object') {
                switchSidebarTab('sem-objects');
            } else {
                switchSidebarTab('terrain');
            }
        }
    });

    UI.initLevelLoader(loadMapFromModule);
    UI.initCompositePNGLoader();
    UI.initSpriteSheetLoader();
    UI.initTilesetLoader( loadMapFromModule.bind(null, g_ctx));

    bindWorkspaceUI();
}

init();