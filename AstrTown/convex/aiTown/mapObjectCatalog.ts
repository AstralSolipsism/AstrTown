import { Infer, ObjectType, v } from 'convex/values';

// 物体占地偏移（相对于放置点）
export const occupiedTile = v.object({
  dx: v.number(),
  dy: v.number(),
});
export type OccupiedTile = Infer<typeof occupiedTile>;

// 贴图帧配置（在贴图中的位置与尺寸）
export const frameConfig = v.object({
  x: v.number(),
  y: v.number(),
  width: v.number(),
  height: v.number(),
});
export type FrameConfig = Infer<typeof frameConfig>;

// 地图物体目录的标准化结构
export const mapObjectCatalogFields = {
  key: v.string(),
  name: v.string(),
  category: v.string(),
  description: v.string(),
  interactionHint: v.optional(v.string()),
  tileSetUrl: v.optional(v.string()),
  frameConfig: v.optional(frameConfig),
  anchorX: v.optional(v.number()),
  anchorY: v.optional(v.number()),
  occupiedTiles: v.array(occupiedTile),
  blocksMovement: v.boolean(),
  enabled: v.boolean(),
  version: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
};

export const mapObjectCatalogObject = v.object(mapObjectCatalogFields);
export type MapObjectCatalog = ObjectType<typeof mapObjectCatalogFields>;
export type MapObjectCatalogInput = Infer<typeof mapObjectCatalogObject>;
