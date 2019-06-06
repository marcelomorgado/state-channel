/* eslint-disable security/detect-non-literal-fs-filename */

const TokenChannels = artifacts.require('TokenChannels');
const Dai = artifacts.require('Dai');

const { BN, expectRevert } = require('openzeppelin-test-helpers');
const { expect } = require('chai');
const testHelpers = require('./helpers');

const { expectEvent, sign } = testHelpers;
const { utils } = web3;
const { toWei, keccak256 } = utils;

/*
 * States
 */
const channelStates = [];

const getLastState = () => {
  const lastState = channelStates[channelStates.length - 1];
  return lastState;
};

// Update channel state
const offChainTransfer = async (from, to, value) => {
  const lastState = getLastState();
  const { channelId, partyAddress, counterPartyAddress } = lastState;
  let { partyBalance, counterPartyBalance, nonce } = lastState;

  // Update balances and nonce
  partyBalance = from === partyAddress ? partyBalance.sub(value) : partyBalance.add(value);

  counterPartyBalance =
    from === counterPartyAddress ? counterPartyBalance.sub(value) : counterPartyBalance.add(value);

  nonce = nonce.add(new BN(1));

  // Sign
  const stateEncoded = web3.eth.abi.encodeParameters(
    ['bytes32', 'uint', 'uint', 'uint'],
    [channelId, `${partyBalance}`, `${counterPartyBalance}`, `${nonce}`]
  );
  const stateHash = keccak256(stateEncoded);
  const partySignature = await sign(stateHash, from === partyAddress ? from : to);
  const counterPartySignature = await sign(stateHash, from === counterPartyAddress ? from : to);

  // Save new state
  const newState = {
    ...lastState,
    partyBalance,
    counterPartyBalance,
    nonce,
    partySignature,
    counterPartySignature
  };
  channelStates.push(newState);
};

contract.only('TokenChannels', accounts => {
  const [root, alice, bob] = accounts;

  let dai;
  let daiAddress;
  let channel;
  let channelAddress;

  const aliceDeposit = toWei('10', 'ether');
  const bobDeposit = toWei('5', 'ether');

  before(async () => {
    dai = await Dai.new();
    ({ address: daiAddress } = dai);

    channel = await TokenChannels.new();
    ({ address: channelAddress } = channel);

    // Parties should be funded with tokens
    await dai.mint(alice, aliceDeposit, { from: root });
    await dai.mint(bob, bobDeposit, { from: root });

    const aliceBalance = (await dai.balanceOf(alice)).toString();
    const bobBalance = (await dai.balanceOf(bob)).toString();

    expect(aliceBalance).to.equal(aliceDeposit);
    expect(bobBalance).to.equal(bobDeposit);

    // Parties should approve Channel contract
    const aliceApprovalTx = await dai.approve(channelAddress, aliceDeposit, { from: alice });
    expectEvent(aliceApprovalTx, 'Approval');

    const bobApprovalTx = await dai.approve(channelAddress, bobDeposit, { from: bob });
    expectEvent(bobApprovalTx, 'Approval');
  });

  it('alice should open a channel', async () => {
    const conterParty = bob;
    const amount = aliceDeposit;

    const tx = await channel.open(daiAddress, conterParty, amount, {
      from: alice
    });

    // ChannelOpened event should be emitted
    const { args } = tx.logs.find(l => l.event === 'ChannelOpened');
    const { channelId } = args;
    expect(channelId).to.be.ok;

    // Channel should be funded
    const expectedBalance = new BN(aliceDeposit);
    const balance = await dai.balanceOf(channelAddress);
    expect(balance).to.be.bignumber.equal(expectedBalance);

    // Save initial state
    const initialState = await channel.channels.call(channelId);
    channelStates.push(initialState);
  });

  it('bob should join to the channel', async () => {
    const { channelId } = channelStates.pop();
    const amount = bobDeposit;

    const tx = await channel.join(channelId, amount, { from: bob });
    expectEvent(tx, 'CounterPartyJoined', { channelId });

    const expectedBalance = new BN(aliceDeposit).add(new BN(bobDeposit));
    const balance = await dai.balanceOf(channelAddress);
    expect(balance).to.be.bignumber.equal(expectedBalance);

    // Update initial state
    const initialState = await channel.channels.call(channelId);
    channelStates.push(initialState);
  });

  it('should do an off-chain transfer', async () => {
    const value = new BN(toWei('9', 'ether'));
    await offChainTransfer(alice, bob, value);
  });

  it('channel should be closed', async () => {
    const {
      channelId,
      partyBalance: aliceFinalBalance,
      counterPartyBalance: bobFinalBalance,
      nonce,
      partySignature: aliceSignature,
      counterPartySignature: bobSignature
    } = getLastState();

    const aliceBalanceBefore = await dai.balanceOf(alice);
    const bobBalanceBefore = await dai.balanceOf(bob);

    const tx = await channel.close(
      channelId,
      `${nonce}`,
      `${aliceFinalBalance}`,
      `${bobFinalBalance}`,
      aliceSignature,
      bobSignature,
      { from: alice }
    );

    expectEvent(tx, 'ChannelClosed', { channelId });

    const aliceBalanceAfter = await dai.balanceOf(alice);
    const bobBalanceAfter = await dai.balanceOf(bob);

    const expectedAliceBalance = aliceBalanceBefore.add(aliceFinalBalance);
    const expectedBobBalance = bobBalanceBefore.add(bobFinalBalance);

    expect(aliceBalanceAfter).to.be.bignumber.equal(expectedAliceBalance);
    expect(bobBalanceAfter).to.be.bignumber.equal(expectedBobBalance);
  });
});
