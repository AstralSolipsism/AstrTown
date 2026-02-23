import { GameId } from '../../convex/aiTown/ids.ts';
import { PlayerDescription } from '../../convex/aiTown/playerDescription.ts';
import { World } from '../../convex/aiTown/world.ts';
import { WorldMap } from '../../convex/aiTown/worldMap.ts';
import { Id } from '../../convex/_generated/dataModel';
import { useMemo } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { parseMap } from '../../convex/util/object.ts';

export type ServerGame = {
  world: World;
  playerDescriptions: Map<GameId<'players'>, PlayerDescription>;
  worldMap: WorldMap;
};

// TODO: This hook reparses the game state (even if we're not rerunning the query)
// when used in multiple components. Move this to a context to only parse it once.
export function useServerGame(worldId: Id<'worlds'> | undefined): ServerGame | undefined {
  const worldState = useQuery(api.world.worldState, worldId ? { worldId } : 'skip');
  const descriptions = useQuery(api.world.gameDescriptions, worldId ? { worldId } : 'skip');
  const game = useMemo(() => {
    if (!worldState || !descriptions) {
      return undefined;
    }
    return {
      world: new World(worldState.world),
      playerDescriptions: parseMap(
        descriptions.playerDescriptions,
        PlayerDescription,
        (p: any) => p.playerId,
      ),
      worldMap: new WorldMap(descriptions.worldMap),
    };
  }, [worldState, descriptions]);
  return game;
}
