/* eslint-disable security/detect-non-literal-fs-filename */
const StateChannels = artifacts.require('StateChannels');
const { utils, eth } = web3;
const { BN, toWei, randomHex } = utils;
const { getBalance } = eth;

// Tech-debt: Extract to testHelpers
const expectEvent = (tx, eventName, expectedArgs) => {
  const { logs } = tx;
  const log = logs.find(l => l.event === eventName);
  expect(log, `Event '${eventName}' not found`).to.be.ok;
  const { args } = log;
  expect(args).to.include(expectedArgs);
};

contract('StateChannels', accounts => {
  const [alice, bob] = accounts;
  let contract;
  let channelId;
  const aliceValue = toWei('10', 'ether');
  const bobValue = toWei('5', 'ether');

  before(async () => {
    contract = await StateChannels.new();
    channelId = randomHex(32);
  });

  it('alice should open a channel', async () => {
    const tx = await contract.open(channelId, bob, aliceValue, { from: alice, value: aliceValue });

    expectEvent(tx, 'ChannelOpened', { channelId });

    const expectedBalance = aliceValue;
    const balance = await getBalance(contract.address);
    expect(balance).to.equal(expectedBalance);
  });

  it('bob should join to the channel', async () => {
    const tx = await contract.join(channelId, { from: bob, value: bobValue });

    expectEvent(tx, 'CounterPartyJoined', { channelId });

    const expectedBalance = new BN(aliceValue).add(new BN(bobValue)).toString();
    const balance = await getBalance(contract.address);
    expect(balance).to.equal(expectedBalance);
  });

  it.skip("should get error if channel id doesn't exists");
});
