function createMutex() {
  let chain = Promise.resolve();

  function run(fn) {
    const next = chain.then(
      () => fn(),
      () => fn()
    );
    chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  return { run };
}

module.exports = {
  createMutex,
};
