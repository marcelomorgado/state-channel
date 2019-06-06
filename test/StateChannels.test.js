/* eslint-disable security/detect-non-literal-fs-filename */
const StateChannels = artifacts.require('StateChannels');
const { utils, eth } = web3;
const { BN, toWei, randomHex, keccak256 } = utils;
const { getBalance, getTransaction } = eth;

// Tech-debt: Extract to testHelpers
const expectEvent = (tx, eventName, expectedArgs) => {
  const { logs } = tx;
  const log = logs.find(l => l.event === eventName);
  expect(log, `Event '${eventName}' not found`).to.be.ok;
  const { args } = log;
  expect(args).to.include(expectedArgs);
};

// Note: eth.getGasPrice is working using ganache-cli but doesn't using truffle
const getGasPrice = async txHash => {
  const receipt = await web3.eth.getTransaction(txHash);
  const gasPrice = await receipt.gasPrice;
  return gasPrice;
};

// Note: Extracted from: https://github.com/OpenZeppelin/openzeppelin-solidity/blob/8545c99fb106636c194da739bd0ede43a9595580/test/helpers/sign.js#L12
const fixSignature = signature => {
  // in geth its always 27/28, in ganache its 0/1. Change to 27/28 to prevent
  // signature malleability if version is 0/1
  // see https://github.com/ethereum/go-ethereum/blob/v1.8.23/internal/ethapi/api.go#L465
  let v = parseInt(signature.slice(130, 132), 16);
  if (v < 27) {
    v += 27;
  }
  const vHex = v.toString(16);
  return signature.slice(0, 130) + vHex;
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
    const tx = await contract.open(channelId, bob, aliceValue, {
      from: alice,
      value: aliceValue
    });

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

  it('channel should be closed', async () => {
    const sequenceNumber = 1;
    const aliceNewBalance = toWei('1', 'ether');
    const bobNewBalance = toWei('14', 'ether');
    const stateEncoded = web3.eth.abi.encodeParameters(
      ['bytes32', 'uint', 'uint', 'uint'],
      [channelId, aliceNewBalance, bobNewBalance, sequenceNumber]
    );
    const stateHash = keccak256(stateEncoded);
    const aliceSignature = await web3.eth.sign(stateHash, alice);
    const bobSignature = await web3.eth.sign(stateHash, bob);

    const aliceBalanceBefore = await getBalance(alice);
    const bobBalanceBefore = await getBalance(bob);

    const tx = await contract.close(
      channelId,
      sequenceNumber,
      aliceNewBalance,
      bobNewBalance,
      fixSignature(aliceSignature),
      fixSignature(bobSignature),
      { from: alice }
    );

    expectEvent(tx, 'ChannelClosed', { channelId });

    const { receipt } = tx;
    const { gasUsed } = receipt;
    const gasPrice = await getGasPrice(tx.tx);
    const fee = new BN(gasUsed).mul(new BN(gasPrice));

    const aliceBalanceAfter = await getBalance(alice);
    const bobBalancAfter = await getBalance(bob);

    const expectedAliceBalance = new BN(aliceBalanceBefore)
      .add(new BN(aliceNewBalance))
      .sub(fee)
      .toString();

    const expectedBobBalance = new BN(bobBalanceBefore).add(new BN(bobNewBalance)).toString();

    expect(aliceBalanceAfter).to.equal(expectedAliceBalance);
    expect(bobBalancAfter).to.equal(expectedBobBalance);
  });

  it.skip("should get error if channel id doesn't exists");
});
