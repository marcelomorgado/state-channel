/* eslint-disable security/detect-non-literal-fs-filename */
const testHelpers = require('./helpers');

const { expectEvent, sign, getGasPrice } = testHelpers;

const TokenChannels = artifacts.require('TokenChannels');
const Dai = artifacts.require('Dai');

const { utils, eth } = web3;
const { BN, toWei, randomHex, keccak256 } = utils;
const { getBalance } = eth;

contract.only('TokenChannels', accounts => {
  const [root, alice, bob] = accounts;

  let dai;
  let channel;
  let channelId;
  const aliceValue = toWei('10', 'ether');
  const bobValue = toWei('5', 'ether');

  before(async () => {
    dai = await Dai.new();
    channel = await TokenChannels.new();

    // Parties should be funded with tokens
    await dai.mint(alice, aliceValue, { from: root });
    await dai.mint(bob, bobValue, { from: root });

    const aliceBalance = (await dai.balanceOf(alice)).toString();
    const bobBalance = (await dai.balanceOf(bob)).toString();

    expect(aliceBalance).to.equal(aliceValue);
    expect(bobBalance).to.equal(bobValue);

    // Parties should approve Channel contract
    const tx = await dai.approve(channel.address, aliceValue, { from: alice });
    expectEvent(tx, 'Approval', {
      owner: alice,
      spender: channel.address
      // value: new BN(aliceValue): Tech-debt: Use chai-bn
    });
  });

  it.only('alice should open a channel', async () => {
    const { address: tokenAddress } = dai;
    const conterParty = bob;
    const amount = aliceValue;

    const tx = await channel.open(tokenAddress, conterParty, amount, {
      from: alice
    });

    // ChannelOpened event whould be emitted
    const { args } = tx.logs.find(l => l.event === 'ChannelOpened');
    ({ channelId } = args);
    expect(channelId).to.be.ok;

    // Channel should be funded
    const expectedBalance = aliceValue;
    const balance = (await dai.balanceOf(channel.address)).toString();
    expect(balance).to.equal(expectedBalance);
  });

  it('bob should join to the channel', async () => {
    const tx = await channel.join(channelId, { from: bob, value: bobValue });

    expectEvent(tx, 'CounterPartyJoined', { channelId });

    const expectedBalance = new BN(aliceValue).add(new BN(bobValue)).toString();
    const balance = await getBalance(channel.address);
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
    const aliceSignature = await sign(stateHash, alice);
    const bobSignature = await sign(stateHash, bob);

    const aliceBalanceBefore = await getBalance(alice);
    const bobBalanceBefore = await getBalance(bob);

    const tx = await channel.close(
      channelId,
      sequenceNumber,
      aliceNewBalance,
      bobNewBalance,
      aliceSignature,
      bobSignature,
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
