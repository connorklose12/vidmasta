
export default {
  bootstrap: () => import('./main.server.mjs').then(m => m.default),
  inlineCriticalCss: true,
  baseHref: '/vidmasta/',
  locale: undefined,
  routes: [
  {
    "renderMode": 1,
    "redirectTo": "/vidmasta/login",
    "route": "/vidmasta"
  },
  {
    "renderMode": 1,
    "route": "/vidmasta/login"
  },
  {
    "renderMode": 1,
    "route": "/vidmasta/upload"
  }
],
  entryPointToBrowserMapping: undefined,
  assets: {
    'index.csr.html': {size: 442, hash: 'f4f43869268299cf53fa9f44656fb41f5902c26d683dfd8ff16a5223d1c184ee', text: () => import('./assets-chunks/index_csr_html.mjs').then(m => m.default)},
    'index.server.html': {size: 955, hash: 'd280cb6a94caf79621f1d7ad7ae8d05ddd25a2dfea92f591aeb312153bc816b3', text: () => import('./assets-chunks/index_server_html.mjs').then(m => m.default)},
    'styles-5INURTSO.css': {size: 0, hash: 'menYUTfbRu8', text: () => import('./assets-chunks/styles-5INURTSO_css.mjs').then(m => m.default)}
  },
};
