import type { Player } from './entities.js';

export interface ChassisDef {
  id: string;
  name: string;
  sub: string;
  description: string;
  cost: number;
  bombs: number;
  power: number;
  speed: number;
  shield: number;
  pushTimeMult: number;
  bombFuse: number;
  color: string;
}

export const CHASSIS_LIST: ChassisDef[] = [
  {
    id: 'standard',
    name: 'STANDARD',
    sub: 'Balanced all-around runner',
    description: '1 Bomb · 2 Blast · Normal Speed. Reliable baseline unit.',
    cost: 0,
    bombs: 1,
    power: 2,
    speed: 0,
    shield: 0,
    pushTimeMult: 1.55,
    bombFuse: 2.1,
    color: '#b4ff39',
  },
  {
    id: 'blaster',
    name: 'BLASTER SPEC',
    sub: 'Demolition specialist',
    description: '1 Bomb · 3 Blast · -1 Speed. Massive blast reach from the start.',
    cost: 150,
    bombs: 1,
    power: 3,
    speed: -1,
    shield: 0,
    pushTimeMult: 1.55,
    bombFuse: 2.0,
    color: '#ffb020',
  },
  {
    id: 'sapper',
    name: 'SAPPER SPEC',
    sub: 'Multi-bomb deployer',
    description: '2 Bombs · 1 Blast · Fast fuse. Lay tactical minefields.',
    cost: 250,
    bombs: 2,
    power: 1,
    speed: 0,
    shield: 0,
    pushTimeMult: 1.55,
    bombFuse: 1.85,
    color: '#ff2d95',
  },
  {
    id: 'sprinter',
    name: 'SPRINTER SPEC',
    sub: 'High-agility courier',
    description: '+2 Speed · 1 Bomb · 2 Blast. Fast movement to outrun the Void.',
    cost: 350,
    bombs: 1,
    power: 2,
    speed: 2,
    shield: 0,
    pushTimeMult: 1.55,
    bombFuse: 2.1,
    color: '#21e6ff',
  },
  {
    id: 'demolisher',
    name: 'DEMOLISHER',
    sub: 'Heavy shard handler',
    description: 'Instant Shard Push (0 lag) · 1 Shield · 2.3s Fuse. Solves gates with ease.',
    cost: 500,
    bombs: 1,
    power: 2,
    speed: 0,
    shield: 1,
    pushTimeMult: 1.0,
    bombFuse: 2.3,
    color: '#9b5cff',
  },
];

export function getChassis(id: string): ChassisDef {
  return CHASSIS_LIST.find((c) => c.id === id) || CHASSIS_LIST[0];
}

export function applyChassis(player: Player, chassisId: string): void {
  const def = getChassis(chassisId);
  player.chassis = def.id;
  player.bombs = def.bombs;
  player.power = def.power;
  player.speed = def.speed;
  player.shield = def.shield;
  player.pushTimeMult = def.pushTimeMult;
  player.bombFuse = def.bombFuse;
}
