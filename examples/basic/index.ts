import { EluGuard } from '../../src';

async function callDownstream(): Promise<string> {
  // Replace with a real downstream call - an HTTP request, a DB query, etc.
  return 'downstream response';
}

async function main() {
  // Zero-config: sane defaults for everything.
  const guard = new EluGuard();

  const result = await guard.execute(() => callDownstream());
  console.log(result);
  console.log(guard.stats());

  await guard.stop();
}

main();
