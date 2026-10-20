'use strict';

/**
 * Niche hubs — what FreshCatch scans, one hub per service area.
 * subreddits    → live chatter (name mining + buyer-intent verification)
 * searchPhrases → Google News / Hacker News queries
 * githubTopics  → GitHub topic searches (rotated one per scan)
 * verbs         → service verbs used to build name-anchored micro keywords
 */

const HUBS = [
  {
    id: 'ai-automation',
    label: 'AI Automation & Agents',
    subreddits: ['AI_Agents', 'n8n', 'AI_Tools', 'LocalLLaMA'],
    blocklist: ['prompt', 'prompts', 'embedding', 'embeddings', 'token', 'tokens'],
    searchPhrases: ['ai agent', 'ai automation', 'ai workflow', 'no-code automation'],
    githubTopics: ['ai-agents', 'automation', 'llm-agents'],
    verbs: ['setup', 'automation', 'integration', 'agent', 'workflow', 'custom', 'template', 'consultant'],
  },
  {
    id: 'game-dev',
    label: 'Game Development',
    subreddits: ['unity3d', 'godot', 'unrealengine', 'robloxgamedev'],
    blocklist: ['roguelike', 'metroidvania', 'pixelart', 'sprite', 'sprites', 'prototype'],
    searchPhrases: ['game engine', 'indie game tool', 'game development framework'],
    githubTopics: ['game-engine', 'godot', 'unity'],
    verbs: ['setup', 'custom', 'mod', 'development', 'fix', 'prototype', 'script'],
  },
  {
    id: 'web-dev',
    label: 'Web Dev & Design',
    subreddits: ['Wordpress', 'shopify', 'webdesign'],
    blocklist: ['landing', 'checkout', 'layout', 'wireframe', 'mockup'],
    searchPhrases: ['wordpress plugin', 'shopify app', 'website builder', 'page builder'],
    githubTopics: ['wordpress-plugin', 'shopify-app', 'headless-cms'],
    verbs: ['setup', 'customization', 'theme', 'plugin', 'migration', 'fix', 'redesign', 'integration'],
  },
  {
    id: 'excel-data',
    label: 'Excel & Data',
    subreddits: ['excel', 'powerbi', 'sheets'],
    blocklist: ['formula', 'formulas', 'macro', 'macros', 'vlookup', 'pivot', 'worksheet'],
    searchPhrases: ['excel add-in', 'spreadsheet tool', 'power bi', 'data dashboard'],
    githubTopics: ['excel', 'spreadsheet', 'power-bi'],
    verbs: ['template', 'dashboard', 'automation', 'macro', 'formula', 'custom', 'fix'],
  },
  {
    id: 'video-animation',
    label: 'Video & Animation',
    subreddits: ['aftereffects', 'MotionDesign', 'blender', 'AIvideo'],
    blocklist: ['keyframe', 'keyframes', 'render', 'rendering', 'timeline'],
    searchPhrases: ['animation tool', 'ai video', 'motion graphics software', 'video generator'],
    githubTopics: ['animation', 'ai-video', 'motion-graphics'],
    verbs: ['animation', 'template', 'custom', 'intro', 'explainer', 'editing'],
  },
  {
    id: 'minecraft-modding',
    label: 'Minecraft Modding',
    subreddits: ['feedthebeast', 'Minecraftmods', 'fabricmc'],
    blocklist: [
      'mojang', 'villager', 'villagers', 'warden', 'mob', 'mobs', 'biome', 'biomes', 'nether',
      'portal', 'jukebox', 'diamond', 'diamonds', 'redstone', 'chunk', 'chunks', 'realm', 'realms',
      'snapshot', 'snapshots', 'bedrock', 'seed', 'seeds', 'texture', 'textures', 'hardcore',
      'smithing', 'elytra', 'spawn', 'dinos', 'dino', 'homestead', 'modded',
      'steampunk', 'roleplay', 'whitelist', 'medieval', 'fantasy', 'magic', 'horror', 'adventure', 'survival', 'buggy',
    ],
    searchPhrases: ['minecraft mod', 'minecraft modpack', 'minecraft server software'],
    githubTopics: ['minecraft', 'minecraft-mod', 'fabric'],
    verbs: ['mod', 'modpack', 'setup', 'server', 'fix', 'port', 'custom'],
  },
];

const hubById = (id) => HUBS.find((h) => h.id === id);
HUBS.forEach((h) => {
  h.builtin = true;
});

module.exports = { HUBS, hubById };
