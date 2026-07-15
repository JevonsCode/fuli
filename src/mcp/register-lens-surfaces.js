import {
  buildInterviewPromptMessages,
  INTERVIEW_PROMPT_DESCRIPTION,
  INTERVIEW_PROMPT_NAME
} from '../lens/interview-prompt.js';

const JSON_MIME_TYPE = 'application/json';
const RESOURCES = Object.freeze([
  {
    name: 'current-personal-lens',
    uri: 'fuli://lens/current',
    description: '当前 active personal space 的安全 Personal Lens 投影',
    read: (resources) => resources.current()
  },
  {
    name: 'personal-lens-history',
    uri: 'fuli://lens/history',
    description: '当前 active personal space 的有界 Personal Lens 历史；budget.itemsBytes 是 items JSON 的 UTF-8 字节数',
    read: (resources) => resources.history()
  },
  {
    name: 'subscribed-public-spaces',
    uri: 'fuli://spaces/subscribed',
    description: '当前 active personal space 订阅的公共空间',
    read: (resources) => resources.subscribed()
  }
]);

export function registerLensSurfaces(server, app) {
  server.registerPrompt(INTERVIEW_PROMPT_NAME, {
    description: INTERVIEW_PROMPT_DESCRIPTION
  }, async () => ({ messages: buildInterviewPromptMessages() }));

  for (const resource of RESOURCES) {
    server.registerResource(resource.name, resource.uri, {
      description: resource.description,
      mimeType: JSON_MIME_TYPE
    }, async () => readResource(resource, app.lensResources));
  }
}

function readResource(resource, resources) {
  try {
    return {
      contents: [{
        uri: resource.uri,
        mimeType: JSON_MIME_TYPE,
        text: JSON.stringify(resource.read(resources))
      }]
    };
  } catch {
    throw new Error('Resource unavailable');
  }
}
