import { Infer, ObjectType, v } from 'convex/values';

// 世界中的物体实例
export const semanticObjectInstance = v.object({
  instanceId: v.string(),
  catalogKey: v.string(),
  x: v.number(),
  y: v.number(),
  note: v.optional(v.string()),
});
export type SemanticObjectInstance = Infer<typeof semanticObjectInstance>;

// 矩形区域边界
export const zoneBounds = v.object({
  x: v.number(),
  y: v.number(),
  width: v.number(),
  height: v.number(),
});
export type ZoneBounds = Infer<typeof zoneBounds>;

// 语义区域定义
export const semanticZone = v.object({
  zoneId: v.string(),
  name: v.string(),
  description: v.string(),
  priority: v.number(),
  bounds: zoneBounds,
  suggestedActivities: v.optional(v.array(v.string())),
  containedInstanceIds: v.optional(v.array(v.string())),
});
export type SemanticZone = Infer<typeof semanticZone>;

// 世界语义文档结构
export const worldSemanticFields = {
  worldId: v.id('worlds'),
  version: v.number(),
  updatedAt: v.number(),
  objectInstances: v.array(semanticObjectInstance),
  zones: v.array(semanticZone),
};

export const worldSemanticObject = v.object(worldSemanticFields);
export type WorldSemantic = ObjectType<typeof worldSemanticFields>;
export type WorldSemanticInput = Infer<typeof worldSemanticObject>;
