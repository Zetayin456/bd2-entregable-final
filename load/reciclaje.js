import http from 'k6/http';
import { check, sleep } from 'k6';

const target = __ENV.TARGET || 'http://api:8080';
const virtualUsers = Number(__ENV.VUS || 10);
const duration = __ENV.DURATION || '10s';

export const options = {
  vus: virtualUsers,
  duration,
};

export default function () {
  const res = http.get(`${target}/salud`);
  check(res, { 'estado es 200': (r) => r.status === 200 });
  sleep(1);
}