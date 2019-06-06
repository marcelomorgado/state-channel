/* eslint-disable security/detect-non-literal-fs-filename */

const TokenChannels = artifacts.require('TokenChannels');
const Dai = artifacts.require('Dai');

const { BN, expectRevert } = require('openzeppelin-test-helpers');
const { expect } = require('chai');
const testHelpers = require('./helpers');

const { expectEvent, sign } = testHelpers;
const { utils } = web3;
const { toWei, keccak256 } = utils;

contract.only('TokenChannels', accounts => {
  const [root, alice, bob] = accounts;

  let dai;
  let daiAddress;
  let channel;
  let channelAddress;
  let channelId;
  const channelStates = [];
  const aliceValue = toWei('10', 'ether');
  const bobValue = toWei('5', 'ether');

  before(async () => {
    dai = await Dai.new();
    ({ address: daiAddress } = dai);

    channel = await TokenChannels.new();
    ({ address: channelAddress } = channel);

    // Parties should be funded with tokens
    await dai.mint(alice, aliceValue, { from: root });
    await dai.mint(bob, bobValue, { from: root });

    const aliceBalance = (await dai.balanceOf(alice)).toString();
    const bobBalance = (await dai.balanceOf(bob)).toString();

    expect(aliceBalance).to.equal(aliceValue);
    expect(bobBalance).to.equal(bobValue);

    // Parties should approve Channel contract
    const aliceApprovalTx = await dai.approve(channelAddress, aliceValue, { from: alice });
    expectEvent(aliceApprovalTx, 'Approval');

    const bobApprovalTx = await dai.approve(channelAddress, bobValue, { from: bob });
    expectEvent(bobApprovalTx, 'Approval');
  });

  it('alice should open a channel', async () => {
    const conterParty = bob;
    const amount = aliceValue;

    const tx = await channel.open(daiAddress, conterParty, amount, {
      from: alice
    });

    // ChannelOpened event whould be emitted
    const { args } = tx.logs.find(l => l.event === 'ChannelOpened');
    ({ channelId } = args);
    expect(channelId).to.be.ok;

    // Channel should be funded
    const expectedBalance = aliceValue;
    const balance = (await dai.balanceOf(channelAddress)).toString();
    expect(balance).to.equal(expectedBalance);
  });

  it('bob should join to the channel', async () => {
    const amount = bobValue;
    const tx = await channel.join(channelId, amount, { from: bob });

    expectEvent(tx, 'CounterPartyJoined', { channelId });

    const expectedBalance = new BN(aliceValue).add(new BN(bobValue)).toString();
    const balance = (await dai.balanceOf(channelAddress)).toString();
    expect(balance).to.equal(expectedBalance);

    // Save initial state
    const initialState = await channel.channels.call(channelId);
    channelStates.push(initialState);
  });

  it('should do an off-chain transfer', async () => {
    const lastState = channelStates[channelStates.length - 1];
    let { partyBalance, counterPartyBalance, nonce } = lastState;

    // Off-chain transfer of 9 tokens from alice (party) to bob (counterParty)
    const value = new BN(toWei('9', 'ether'));

    partyBalance = partyBalance.sub(value);
    counterPartyBalance = counterPartyBalance.add(value);
    nonce = nonce.add(new BN(1));

    const newState = { ...lastState, partyBalance, counterPartyBalance, nonce };
    channelStates.push(newState);
  });

  const getHashOfChannelState = state => {
    const { partyBalance, counterPartyBalance, nonce } = state;

    const stateEncoded = web3.eth.abi.encodeParameters(
      ['bytes32', 'uint', 'uint', 'uint'],
      [channelId, partyBalance.toString(), counterPartyBalance.toString(), nonce.toString()]
    );

    const stateHash = keccak256(stateEncoded);
    return stateHash;
  };

  it('channel should be closed', async () => {
    const lastState = channelStates[channelStates.length - 1];
    const {
      partyBalance: aliceFinalBalance,
      counterPartyBalance: bobFinalBalance,
      nonce
    } = lastState;
    const stateHash = getHashOfChannelState(lastState);

    const aliceSignature = await sign(stateHash, alice);
    const bobSignature = await sign(stateHash, bob);

    const aliceBalanceBefore = await dai.balanceOf(alice);
    const bobBalanceBefore = await dai.balanceOf(bob);

    const tx = await channel.close(
      channelId,
      nonce.toString(),
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
