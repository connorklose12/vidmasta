
export default {
  basePath: 'https://connorklose12.github.io/vidmasta',
  allowedHosts: [],
  supportedLocales: {
  "en-US": ""
},
  entryPoints: {
    '': () => import('./main.server.mjs')
  },
};
