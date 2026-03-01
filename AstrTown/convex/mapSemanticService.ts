import { mutation, query } from './_generated/server';
import { Id } from './_generated/dataModel';
import { v } from 'convex/values';
import { frameConfig, occupiedTile } from './aiTown/mapObjectCatalog';
import { semanticObjectInstance, semanticZone, zoneBounds } from './aiTown/worldSemantic';

function buildNextVersion(currentVersion: number | undefined, requestedVersion: number | undefined) {
  if (requestedVersion !== undefined) {
    return requestedVersion;
  }
  return (currentVersion ?? 0) + 1;
}

function assertUniqueStringValues(values: string[], fieldName: string) {
  const visited = new Set<string>();
  for (const value of values) {
    if (visited.has(value)) {
      throw new Error(`${fieldName} 存在重复值: ${value}`);
    }
    visited.add(value);
  }
}

function assertZonesReferenceValidInstances(
  zones: Array<{ zoneId: string; containedInstanceIds?: string[] }>,
  objectInstances: Array<{ instanceId: string }>,
) {
  const validIds = new Set(objectInstances.map((instance) => instance.instanceId));
  for (const zone of zones) {
    if (!zone.containedInstanceIds) {
      continue;
    }
    for (const instanceId of zone.containedInstanceIds) {
      if (!validIds.has(instanceId)) {
        throw new Error(`zone(${zone.zoneId}) 引用了不存在的 instanceId: ${instanceId}`);
      }
    }
  }
}

async function assertWorldExists(ctx: { db: any }, worldId: Id<'worlds'>) {
  const world = await ctx.db.get(worldId);
  if (!world) {
    throw new Error(`world 不存在: ${worldId}`);
  }
}

async function getCatalogByKey(ctx: { db: any }, key: string) {
  const db = ctx.db as any;
  return await db
    .query('mapObjectCatalog')
    .withIndex('key', (q: any) => q.eq('key', key))
    .unique();
}

async function assertCatalogKeysEnabled(
  ctx: { db: any },
  objectInstances: Array<{ catalogKey: string }>,
) {
  const keys = Array.from(new Set(objectInstances.map((item) => item.catalogKey)));
  for (const key of keys) {
    const catalog = await getCatalogByKey(ctx, key);
    if (!catalog) {
      throw new Error(`catalogKey 不存在: ${key}`);
    }
    if (!catalog.enabled) {
      throw new Error(`catalogKey 已停用，不能引用: ${key}`);
    }
  }
}

async function getWorldSemanticDoc(ctx: { db: any }, worldId: Id<'worlds'>) {
  const db = ctx.db as any;
  return await db
    .query('worldSemantic')
    .withIndex('worldId', (q: any) => q.eq('worldId', worldId))
    .unique();
}

function buildCoordinateIndex(
  zones: Array<{
    zoneId: string;
    name: string;
    priority: number;
    bounds: { x: number; y: number; width: number; height: number };
  }>,
  mapWidth: number,
  mapHeight: number,
) {
  const normalizedWidth = Math.max(0, Math.trunc(mapWidth));
  const normalizedHeight = Math.max(0, Math.trunc(mapHeight));
  if (normalizedWidth === 0 || normalizedHeight === 0) {
    return undefined;
  }

  // 对超大地图跳过坐标索引，避免查询开销过高。
  if (normalizedWidth * normalizedHeight > 200_000) {
    return undefined;
  }

  const index: Record<string, { zoneId: string; zoneName: string; priority: number }> = {};

  for (const zone of zones) {
    const rawStartX = Math.trunc(zone.bounds.x);
    const rawStartY = Math.trunc(zone.bounds.y);
    const rawWidth = Math.max(0, Math.trunc(zone.bounds.width));
    const rawHeight = Math.max(0, Math.trunc(zone.bounds.height));

    const startX = Math.max(0, rawStartX);
    const startY = Math.max(0, rawStartY);
    const endX = Math.min(normalizedWidth, rawStartX + rawWidth);
    const endY = Math.min(normalizedHeight, rawStartY + rawHeight);

    if (endX <= startX || endY <= startY) {
      continue;
    }

    for (let x = startX; x < endX; x += 1) {
      for (let y = startY; y < endY; y += 1) {
        const key = `${x},${y}`;
        // zones 已按 priority 从高到低排序，首个写入即主区域。
        if (!index[key]) {
          index[key] = {
            zoneId: zone.zoneId,
            zoneName: zone.name,
            priority: zone.priority,
          };
        }
      }
    }
  }

  return index;
}

export const listCatalogObjects = query({
  handler: async (ctx) => {
    const db = ctx.db as any;
    return await db
      .query('mapObjectCatalog')
      .filter((q: any) => q.eq(q.field('enabled'), true))
      .collect();
  },
});

export const getCatalogObject = query({
  args: {
    key: v.string(),
  },
  handler: async (ctx, args) => {
    return await getCatalogByKey(ctx, args.key);
  },
});

export const createCatalogObject = mutation({
  args: {
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
    blocksMovement: v.optional(v.boolean()),
    enabled: v.optional(v.boolean()),
    version: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const key = args.key.trim();
    if (!key) {
      throw new Error('key 不能为空');
    }

    const exists = await getCatalogByKey(ctx, key);
    if (exists) {
      throw new Error(`key 已存在: ${key}`);
    }

    const now = Date.now();
    return await (ctx.db as any).insert('mapObjectCatalog', {
      key,
      name: args.name.trim(),
      category: args.category.trim(),
      description: args.description.trim(),
      interactionHint: args.interactionHint,
      tileSetUrl: args.tileSetUrl,
      frameConfig: args.frameConfig,
      anchorX: args.anchorX,
      anchorY: args.anchorY,
      occupiedTiles: args.occupiedTiles,
      blocksMovement: args.blocksMovement ?? true,
      enabled: args.enabled ?? true,
      version: args.version ?? 1,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateCatalogObject = mutation({
  args: {
    key: v.string(),
    name: v.optional(v.string()),
    category: v.optional(v.string()),
    description: v.optional(v.string()),
    interactionHint: v.optional(v.string()),
    tileSetUrl: v.optional(v.string()),
    frameConfig: v.optional(frameConfig),
    anchorX: v.optional(v.number()),
    anchorY: v.optional(v.number()),
    occupiedTiles: v.optional(v.array(occupiedTile)),
    blocksMovement: v.optional(v.boolean()),
    enabled: v.optional(v.boolean()),
    version: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await getCatalogByKey(ctx, args.key);
    if (!existing) {
      throw new Error(`key 不存在: ${args.key}`);
    }

    const patch: Record<string, any> = {
      updatedAt: Date.now(),
      version: buildNextVersion(existing.version, args.version),
    };

    if (args.name !== undefined) patch.name = args.name.trim();
    if (args.category !== undefined) patch.category = args.category.trim();
    if (args.description !== undefined) patch.description = args.description.trim();
    if (args.interactionHint !== undefined) patch.interactionHint = args.interactionHint;
    if (args.tileSetUrl !== undefined) patch.tileSetUrl = args.tileSetUrl;
    if (args.frameConfig !== undefined) patch.frameConfig = args.frameConfig;
    if (args.anchorX !== undefined) patch.anchorX = args.anchorX;
    if (args.anchorY !== undefined) patch.anchorY = args.anchorY;
    if (args.occupiedTiles !== undefined) patch.occupiedTiles = args.occupiedTiles;
    if (args.blocksMovement !== undefined) patch.blocksMovement = args.blocksMovement;
    if (args.enabled !== undefined) patch.enabled = args.enabled;

    await ctx.db.patch(existing._id, patch);
    return existing._id;
  },
});

export const deleteCatalogObject = mutation({
  args: {
    key: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await getCatalogByKey(ctx, args.key);
    if (!existing) {
      throw new Error(`key 不存在: ${args.key}`);
    }

    if (!existing.enabled) {
      return existing._id;
    }

    await ctx.db.patch(existing._id, {
      enabled: false,
      updatedAt: Date.now(),
      version: existing.version + 1,
    });

    return existing._id;
  },
});

export const getWorldSemantic = query({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    return await getWorldSemanticDoc(ctx, args.worldId);
  },
});

export const upsertWorldSemantic = mutation({
  args: {
    worldId: v.id('worlds'),
    version: v.optional(v.number()),
    objectInstances: v.array(semanticObjectInstance),
    zones: v.array(semanticZone),
  },
  handler: async (ctx, args) => {
    await assertWorldExists(ctx, args.worldId);

    assertUniqueStringValues(
      args.objectInstances.map((item) => item.instanceId),
      'objectInstances.instanceId',
    );
    assertUniqueStringValues(
      args.zones.map((zone) => zone.zoneId),
      'zones.zoneId',
    );
    assertZonesReferenceValidInstances(args.zones, args.objectInstances);
    await assertCatalogKeysEnabled(ctx, args.objectInstances);

    const existing = await getWorldSemanticDoc(ctx, args.worldId);
    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        version: buildNextVersion(existing.version, args.version),
        updatedAt: now,
        objectInstances: args.objectInstances,
        zones: args.zones,
      });
      return existing._id;
    }

    return await (ctx.db as any).insert('worldSemantic', {
      worldId: args.worldId,
      version: args.version ?? 1,
      updatedAt: now,
      objectInstances: args.objectInstances,
      zones: args.zones,
    });
  },
});

export const addObjectInstance = mutation({
  args: {
    worldId: v.id('worlds'),
    instanceId: v.string(),
    catalogKey: v.string(),
    x: v.number(),
    y: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertWorldExists(ctx, args.worldId);
    await assertCatalogKeysEnabled(ctx, [{ catalogKey: args.catalogKey }]);

    const existing = await getWorldSemanticDoc(ctx, args.worldId);
    const nextInstance = {
      instanceId: args.instanceId,
      catalogKey: args.catalogKey,
      x: args.x,
      y: args.y,
      note: args.note,
    };

    if (existing) {
      if (existing.objectInstances.some((instance: any) => instance.instanceId === args.instanceId)) {
        throw new Error(`instanceId 已存在: ${args.instanceId}`);
      }
      await ctx.db.patch(existing._id, {
        objectInstances: [...existing.objectInstances, nextInstance],
        updatedAt: Date.now(),
        version: existing.version + 1,
      });
      return existing._id;
    }

    return await (ctx.db as any).insert('worldSemantic', {
      worldId: args.worldId,
      version: 1,
      updatedAt: Date.now(),
      objectInstances: [nextInstance],
      zones: [],
    });
  },
});

export const removeObjectInstance = mutation({
  args: {
    worldId: v.id('worlds'),
    instanceId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await getWorldSemanticDoc(ctx, args.worldId);
    if (!existing) {
      throw new Error(`worldSemantic 不存在: ${args.worldId}`);
    }

    const nextObjectInstances = existing.objectInstances.filter(
      (instance: any) => instance.instanceId !== args.instanceId,
    );

    if (nextObjectInstances.length === existing.objectInstances.length) {
      throw new Error(`instanceId 不存在: ${args.instanceId}`);
    }

    const nextZones = existing.zones.map((zone: any) => {
      if (!zone.containedInstanceIds) {
        return zone;
      }
      return {
        ...zone,
        containedInstanceIds: zone.containedInstanceIds.filter(
          (instanceId: string) => instanceId !== args.instanceId,
        ),
      };
    });

    await ctx.db.patch(existing._id, {
      objectInstances: nextObjectInstances,
      zones: nextZones,
      updatedAt: Date.now(),
      version: existing.version + 1,
    });

    return existing._id;
  },
});

export const addZone = mutation({
  args: {
    worldId: v.id('worlds'),
    zoneId: v.string(),
    name: v.string(),
    description: v.string(),
    priority: v.number(),
    bounds: zoneBounds,
    suggestedActivities: v.optional(v.array(v.string())),
    containedInstanceIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await assertWorldExists(ctx, args.worldId);

    const nextZone = {
      zoneId: args.zoneId,
      name: args.name,
      description: args.description,
      priority: args.priority,
      bounds: args.bounds,
      suggestedActivities: args.suggestedActivities,
      containedInstanceIds: args.containedInstanceIds,
    };

    const existing = await getWorldSemanticDoc(ctx, args.worldId);
    if (existing) {
      if (existing.zones.some((zone: any) => zone.zoneId === args.zoneId)) {
        throw new Error(`zoneId 已存在: ${args.zoneId}`);
      }

      assertZonesReferenceValidInstances([nextZone], existing.objectInstances);

      await ctx.db.patch(existing._id, {
        zones: [...existing.zones, nextZone],
        updatedAt: Date.now(),
        version: existing.version + 1,
      });

      return existing._id;
    }

    assertZonesReferenceValidInstances([nextZone], []);

    return await (ctx.db as any).insert('worldSemantic', {
      worldId: args.worldId,
      version: 1,
      updatedAt: Date.now(),
      objectInstances: [],
      zones: [nextZone],
    });
  },
});

export const updateZone = mutation({
  args: {
    worldId: v.id('worlds'),
    zoneId: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    priority: v.optional(v.number()),
    bounds: v.optional(zoneBounds),
    suggestedActivities: v.optional(v.array(v.string())),
    containedInstanceIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const existing = await getWorldSemanticDoc(ctx, args.worldId);
    if (!existing) {
      throw new Error(`worldSemantic 不存在: ${args.worldId}`);
    }

    const zoneIndex = existing.zones.findIndex((zone: any) => zone.zoneId === args.zoneId);
    if (zoneIndex < 0) {
      throw new Error(`zoneId 不存在: ${args.zoneId}`);
    }

    const currentZone = existing.zones[zoneIndex];
    const nextZone = {
      ...currentZone,
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      ...(args.bounds !== undefined ? { bounds: args.bounds } : {}),
      ...(args.suggestedActivities !== undefined
        ? { suggestedActivities: args.suggestedActivities }
        : {}),
      ...(args.containedInstanceIds !== undefined
        ? { containedInstanceIds: args.containedInstanceIds }
        : {}),
    };

    assertZonesReferenceValidInstances([nextZone], existing.objectInstances);

    const nextZones = [...existing.zones];
    nextZones[zoneIndex] = nextZone;

    await ctx.db.patch(existing._id, {
      zones: nextZones,
      updatedAt: Date.now(),
      version: existing.version + 1,
    });

    return existing._id;
  },
});

export const removeZone = mutation({
  args: {
    worldId: v.id('worlds'),
    zoneId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await getWorldSemanticDoc(ctx, args.worldId);
    if (!existing) {
      throw new Error(`worldSemantic 不存在: ${args.worldId}`);
    }

    const nextZones = existing.zones.filter((zone: any) => zone.zoneId !== args.zoneId);
    if (nextZones.length === existing.zones.length) {
      throw new Error(`zoneId 不存在: ${args.zoneId}`);
    }

    await ctx.db.patch(existing._id, {
      zones: nextZones,
      updatedAt: Date.now(),
      version: existing.version + 1,
    });

    return existing._id;
  },
});

export const getSemanticSnapshot = query({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    const db = ctx.db as any;
    const worldMap = await db
      .query('maps')
      .withIndex('worldId', (q: any) => q.eq('worldId', args.worldId))
      .first();

    if (!worldMap) {
      throw new Error(`地图不存在: ${args.worldId}`);
    }

    const semanticDoc = await getWorldSemanticDoc(ctx, args.worldId);
    const objectInstances = semanticDoc?.objectInstances ?? [];
    const zones = semanticDoc?.zones ?? [];

    const enabledCatalogs = await db
      .query('mapObjectCatalog')
      .filter((q: any) => q.eq(q.field('enabled'), true))
      .collect();
    const catalogByKey = new Map<string, any>(enabledCatalogs.map((item: any) => [item.key, item]));

    const zoneCards = [...zones]
      .sort((a: any, b: any) => b.priority - a.priority)
      .map((zone: any) => ({
        zoneId: zone.zoneId,
        name: zone.name,
        description: zone.description,
        priority: zone.priority,
        bounds: zone.bounds,
        suggestedActivities: zone.suggestedActivities ?? [],
      }));

    const objectCards = objectInstances.map((instance: any) => {
      const catalog = catalogByKey.get(instance.catalogKey);
      return {
        instanceId: instance.instanceId,
        catalogKey: instance.catalogKey,
        name: catalog?.name ?? instance.catalogKey,
        description: catalog?.description ?? `缺少目录定义：${instance.catalogKey}`,
        category: catalog?.category ?? 'unknown',
        position: {
          x: instance.x,
          y: instance.y,
        },
        occupiedTiles: catalog?.occupiedTiles ?? [],
        interactionHint: catalog?.interactionHint ?? null,
        blocksMovement: catalog?.blocksMovement ?? true,
        note: instance.note ?? null,
      };
    });

    return {
      mapSummary: {
        width: worldMap.width,
        height: worldMap.height,
        tileDim: worldMap.tileDim,
        version: semanticDoc?.version ?? 0,
      },
      zones: zoneCards,
      objects: objectCards,
      coordinateIndex: buildCoordinateIndex(zoneCards, worldMap.width, worldMap.height),
    };
  },
});
