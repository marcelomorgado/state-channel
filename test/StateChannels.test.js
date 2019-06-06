/* eslint-disable security/detect-non-literal-fs-filename */
const StateChannels = artifacts.require('StateChannels');

contract('StateChannels', accounts => {
  const [ana, bob] = accounts;
  let sc;

  beforeEach(async () => {
    sc = await StateChannels.new();
  });

  it('should open a channel', async () => {
    const channelId = web3.utils.asciiToHex('1');
    const value = web3.utils.toWei('10', 'ether');

    await sc.open(channelId, bob, value, { from: ana, value });
  });
});
