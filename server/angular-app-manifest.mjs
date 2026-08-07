
export default {
  bootstrap: () => import('./main.server.mjs').then(m => m.default),
  inlineCriticalCss: true,
  baseHref: 'https://connorklose12.github.io/vidmasta/',
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
    'index.csr.html': {size: 473, hash: '2a05f1e18cd9f19628cd8298f69faf708fb14776f925c41ba31aa307a410bbae', text: () => import('./assets-chunks/index_csr_html.mjs').then(m => m.default)},
    'index.server.html': {size: 986, hash: '983f616d1011f4a06411f88b84cde9ed6ca3ce772aefb1702091891c9fc5763f', text: () => import('./assets-chunks/index_server_html.mjs').then(m => m.default)},
    'styles-5INURTSO.css': {size: 0, hash: 'menYUTfbRu8', text: () => import('./assets-chunks/styles-5INURTSO_css.mjs').then(m => m.default)}
  },
};
