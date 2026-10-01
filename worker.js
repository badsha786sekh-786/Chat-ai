import { onRequest } from './functions/api/[[route]].js';

export default {
  fetch(request, env) {
    return onRequest({ request, env });
  },
};
