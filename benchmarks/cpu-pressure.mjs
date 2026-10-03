// CPU-pressure generator: runs in its own process so it saturates the
// *service* machine without inflating the downstream dependency's latency.
const DUTY = Number(process.env.PRESSURE_DUTY || 0.7);

function burn(ms) {
  const end = Date.now() + ms;
  let acc = 0;
  while (Date.now() < end) acc += Math.sqrt(acc + 1);
  return acc;
}

let sink = 0;
setInterval(() => {
  sink += burn(100 * DUTY);
}, 100).unref?.();

// Exit when the parent disconnects.
process.on('disconnect', () => process.exit(0));
setTimeout(() => process.exit(0), 10 * 60 * 1000).unref?.();
