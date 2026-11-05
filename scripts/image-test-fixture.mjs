import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export const apiKey = 'fake-runpod-image-test-key';
export const failedPrompt = 'Return a controlled image generation failure';
export const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMIr+0AAAKLAV1gTX3oAAAAAElFTkSuQmCC', 'base64');

if (process.env.CHAT_IMAGE_TEST_FIXTURE === 'true') {
  const realFetch = globalThis.fetch;
  const jobs = new Map();
  const endpoint = '/v2/black-forest-labs-flux-1-schnell';
  const imageUrl = 'https://image.runpod.ai/test-fixture/pixel.png';

  globalThis.fetch = async (resource, init) => {
    const url = new URL(resource instanceof Request ? resource.url : resource);
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      return realFetch(resource, init);
    }

    const request = new Request(resource, init);
    if (url.href === imageUrl) {
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.get('authorization'), null);
      return new Response(imageBytes, { headers: { 'Content-Type': 'image/png' } });
    }
    assert.equal(url.origin, 'https://api.runpod.ai', 'Unexpected external fetch from the test app');
    assert.equal(request.headers.get('authorization'), `Bearer ${apiKey}`);

    if (url.pathname === `${endpoint}/run`) {
      assert.equal(request.method, 'POST');
      const { input } = await request.json();
      assert.equal(typeof input.prompt, 'string');
      assert.equal(input.width, 1024);
      assert.equal(input.height, 1024);
      const id = randomUUID();
      jobs.set(id, { polls: 0, fails: input.prompt === failedPrompt });
      return Response.json({ id, status: 'IN_QUEUE' });
    }

    assert.ok(url.pathname.startsWith(`${endpoint}/status/`), 'Unexpected Runpod fixture route');
    assert.equal(request.method, 'GET');
    const id = url.pathname.slice(`${endpoint}/status/`.length);
    const job = jobs.get(id);
    if (!job) return Response.json({ error: 'Fixture job expired' }, { status: 404 });
    job.polls += 1;
    if (job.fails) return Response.json({ id, status: 'FAILED', error: 'private upstream fixture error' });
    if (job.polls === 1) return Response.json({ id, status: 'IN_PROGRESS' });
    return Response.json({ id, status: 'COMPLETED', output: { image_url: imageUrl } });
  };
}
