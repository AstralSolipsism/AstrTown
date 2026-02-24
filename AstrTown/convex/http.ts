import { httpRouter } from 'convex/server';
import { getAuthMe, optionsAuth, postAuthLogin, postAuthLogout, postAuthRegister } from './auth';
import { handleReplicateWebhook } from './music';
import {
  getAgentStatus,
  getSocialState,
  getWorldState,
  postCommand,
  postCommandBatchHttp,
  postDescriptionUpdate,
  postEventAck,
  postMemoryInject,
  postMemorySearch,
  getRecentMemories,
  postSocialAffinity,
  postSocialRelationship,
  postTokenCreate,
  postTokenValidate,
} from './botApi';
import { getNpcList, getNpcTokenById, optionsNpc, postNpcCreate, postNpcResetToken } from './npcService';

const http = httpRouter();
http.route({
  path: '/replicate_webhook',
  method: 'POST',
  handler: handleReplicateWebhook,
});

http.route({
  path: '/api/bot/command',
  method: 'POST',
  handler: postCommand,
});

http.route({
  path: '/api/bot/command/batch',
  method: 'POST',
  handler: postCommandBatchHttp,
});

http.route({
  path: '/api/bot/description/update',
  method: 'POST',
  handler: postDescriptionUpdate,
});

http.route({
  path: '/api/bot/event',
  method: 'POST',
  handler: postEventAck,
});

http.route({
  path: '/api/bot/world-state',
  method: 'GET',
  handler: getWorldState,
});

http.route({
  path: '/api/bot/agent-status',
  method: 'GET',
  handler: getAgentStatus,
});

http.route({
  path: '/api/bot/token/validate',
  method: 'POST',
  handler: postTokenValidate,
});

http.route({
  path: '/api/bot/token/create',
  method: 'POST',
  handler: postTokenCreate,
});

http.route({
  path: '/api/bot/memory/search',
  method: 'POST',
  handler: postMemorySearch,
});

http.route({
  path: '/api/bot/memory/recent',
  method: 'GET',
  handler: getRecentMemories,
});

http.route({
  path: '/api/auth/register',
  method: 'POST',
  handler: postAuthRegister,
});

http.route({
  path: '/api/auth/login',
  method: 'POST',
  handler: postAuthLogin,
});

http.route({
  path: '/api/auth/logout',
  method: 'POST',
  handler: postAuthLogout,
});

http.route({
  path: '/api/auth/me',
  method: 'GET',
  handler: getAuthMe,
});

http.route({
  pathPrefix: '/api/auth/',
  method: 'OPTIONS',
  handler: optionsAuth,
});

http.route({
  path: '/api/npc/create',
  method: 'POST',
  handler: postNpcCreate,
});

http.route({
  path: '/api/npc/list',
  method: 'GET',
  handler: getNpcList,
});

http.route({
  path: '/api/npc/reset-token',
  method: 'POST',
  handler: postNpcResetToken,
});

http.route({
  pathPrefix: '/api/npc/token/',
  method: 'GET',
  handler: getNpcTokenById,
});

http.route({
  pathPrefix: '/api/npc/',
  method: 'OPTIONS',
  handler: optionsNpc,
});

http.route({
  path: '/api/bot/social/affinity',
  method: 'POST',
  handler: postSocialAffinity,
});

http.route({
  path: '/api/bot/social/state',
  method: 'GET',
  handler: getSocialState,
});

http.route({
  path: '/api/bot/social/relationship',
  method: 'POST',
  handler: postSocialRelationship,
});

http.route({
  path: '/api/bot/memory/inject',
  method: 'POST',
  handler: postMemoryInject,
});

export default http;
