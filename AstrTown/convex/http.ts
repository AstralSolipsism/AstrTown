import { httpRouter } from 'convex/server';
import { getAuthMe, optionsAuth, postAuthLogin, postAuthLogout, postAuthRegister } from './auth';
import { handleReplicateWebhook } from './music';
import {
  getAgentStatus,
  getWorldState,
  postCommand,
  postControl,
  postDescriptionUpdate,
  postEventAck,
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
  path: '/api/bot/control',
  method: 'POST',
  handler: postControl,
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

export default http;
