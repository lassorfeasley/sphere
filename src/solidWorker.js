import { buildStrutSolid } from './solid.js';

self.onmessage = async ({ data }) => {
  try {
    const mesh = await buildStrutSolid(data);
    // Copy out of the wasm heap so the buffers can be transferred.
    const vertProperties = new Float32Array(mesh.vertProperties);
    const triVerts = new Uint32Array(mesh.triVerts);
    self.postMessage({ mesh: { ...mesh, vertProperties, triVerts } }, [vertProperties.buffer, triVerts.buffer]);
  } catch (error) {
    self.postMessage({ error: String(error?.message ?? error) });
  }
};
