/* eslint-disable security/detect-non-literal-fs-filename */

const TokenChannels = artifacts.require('TokenChannels');
const Dai = artifacts.require('Dai');

const { BN, expectRevert, time } = require('openzeppelin-test-helpers');
const { expect } = require('chai');
const testHelpers = require('./helpers');

const { expectEvent, sign } = testHelpers;
const { utils } = web3;
const { toWei, keccak256 } = utils;

const ChannelStatus = {
  OPEN: new BN(0),
  ON_CHALLENGE: new BN(1),
  CLOSED: new BN(2)
};

const ONE_TOKEN = new BN(toWei('1', 'ether'));
const FIVE_TOKENS = new BN(toWei('5', 'ether'));
const TEN_TOKENS = new BN(toWei('10', 'ether'));

/*
 * States
 */
let channelStates = [];

const getLastState = () => {
  const lastState = channelStates[channelStates.length - 1];
  return lastState;
};

const signChannelState = async state => {
  const {
    channelId,
    nonce,
    partyAddress,
    partyBalance,
    counterPartyAddress,
    counterPartyBalance
  } = state;
  // Sign
  const stateEncoded = web3.eth.abi.encodeParameters(
    ['bytes32', 'uint', 'uint', 'uint'],
    [channelId, `${partyBalance}`, `${counterPartyBalance}`, `${nonce}`]
  );
  const stateHash = keccak256(stateEncoded);
  const partySignature = await sign(stateHash, partyAddress);
  const counterPartySignature = await sign(stateHash, counterPartyAddress);
  return { partySignature, counterPartySignature };
};

// Update channel state
const offChainTransfer = async (from, to, value) => {
  const lastState = getLastState();
  const { partyAddress } = lastState;
  let { partyBalance, counterPartyBalance, nonce } = lastState;

  if (from === partyAddress) {
    partyBalance = partyBalance.sub(value);
    counterPartyBalance = counterPartyBalance.add(value);
  } else {
    partyBalance = partyBalance.add(value);
    counterPartyBalance = counterPartyBalance.sub(value);
  }

  nonce = nonce.add(new BN(1));

  // Prepare new state
  const newState = {
    ...lastState,
    partyBalance,
    counterPartyBalance,
    nonce
  };

  // Sign
  const { partySignature, counterPartySignature } = await signChannelState(newState);

  // Save new state
  channelStates.push({ ...newState, partySignature, counterPartySignature });
};

contract('TokenChannels', accounts => {
  const [root, alice, bob, carl] = accounts;
  const oneDayPeriod = time.duration.days(1);

  let token;
  let tokenAddress;
  let channel;
  let channelAddress;

  const aliceDeposit = TEN_TOKENS;
  const bobDeposit = FIVE_TOKENS;

  const instantiateContracts = async () => {
    token = await Dai.new();
    ({ address: tokenAddress } = token);

    channel = await TokenChannels.new();
    ({ address: channelAddress } = channel);
  };

  const mintTokens = async (to, amount) => {
    const balanceBefore = await token.balanceOf(to);
    expect(balanceBefore).to.be.bignumber.equal(new BN(0));

    await token.mint(to, amount, { from: root });

    const balanceAfter = await token.balanceOf(to);

    expect(balanceAfter).to.be.bignumber.equal(new BN(amount));
  };

  const approveChannelContract = async (from, amount) => {
    const tx = await token.approve(channelAddress, amount, { from });
    expectEvent(tx, 'Approval');
  };

  const openChannel = async (challengePeriod = 0) => {
    const amount = aliceDeposit;
    const tx = await channel.open(tokenAddress, bob, amount, challengePeriod, { from: alice });

    // ChannelOpened event should be emitted
    const { args } = tx.logs.find(l => l.event === 'ChannelOpened');
    const { channelId } = args;
    expect(channelId).to.be.ok;

    // Channel should be funded
    const expectedBalance = new BN(aliceDeposit);
    const balance = await token.balanceOf(channelAddress);
    expect(balance).to.be.bignumber.equal(expectedBalance);

    // Save initial state
    const initialState = await channel.channels.call(channelId);

    expect(initialState.status).to.be.bignumber.equal(ChannelStatus.OPEN);
    expect(initialState.challengePeriod).to.be.bignumber.equal(new BN(challengePeriod));

    channelStates.push(initialState);
  };

  const joinChannel = async () => {
    const { channelId } = channelStates.pop();
    const amount = bobDeposit;

    const tx = await channel.join(channelId, amount, { from: bob });
    expectEvent(tx, 'CounterPartyJoined', { channelId });

    const expectedBalance = new BN(aliceDeposit).add(new BN(bobDeposit));
    const balance = await token.balanceOf(channelAddress);
    expect(balance).to.be.bignumber.equal(expectedBalance);

    // Update initial state
    const initialState = await channel.channels.call(channelId);
    channelStates.push(initialState);

    return tx;
  };

  const closeChannel = async (state, senderAddress) => {
    const {
      channelId,
      partyBalance,
      counterPartyBalance,
      nonce,
      partySignature,
      counterPartySignature
    } = state;

    const tx = await channel.close(
      channelId,
      `${nonce}`,
      `${partyBalance}`,
      `${counterPartyBalance}`,
      partySignature,
      counterPartySignature,
      { from: senderAddress }
    );

    const { challengePeriod, status } = await channel.channels.call(channelId);
    const channelHasChallengePeriod = challengePeriod.gt(new BN(0));

    if (channelHasChallengePeriod) {
      expectEvent(tx, 'ChannelOnChallenge', { channelId });
      expect(status).to.be.bignumber.equal(ChannelStatus.ON_CHALLENGE);
    } else {
      expectEvent(tx, 'ChannelClosed', { channelId });
      expect(status).to.be.bignumber.equal(ChannelStatus.CLOSED);
    }

    return tx;
  };

  const challange = async (state, sender) => {
    const {
      channelId,
      partyBalance,
      counterPartyBalance,
      nonce,
      partySignature,
      counterPartySignature
    } = state;

    const tx = await channel.challenge(
      channelId,
      `${nonce}`,
      `${partyBalance}`,
      `${counterPartyBalance}`,
      partySignature,
      counterPartySignature,
      { from: sender }
    );

    return tx;
  };

  const offChainTransfers = async () => {
    const {
      partyBalance: aliceBalanceBefore,
      counterPartyBalance: bobBalanceBefore
    } = getLastState();

    expect(aliceBalanceBefore).to.be.bignumber.equal(TEN_TOKENS);
    expect(bobBalanceBefore).to.be.bignumber.equal(FIVE_TOKENS);

    await offChainTransfer(alice, bob, ONE_TOKEN);
    await offChainTransfer(alice, bob, ONE_TOKEN);
    await offChainTransfer(alice, bob, ONE_TOKEN);
    await offChainTransfer(alice, bob, ONE_TOKEN);
    await offChainTransfer(alice, bob, ONE_TOKEN);

    const {
      partyBalance: aliceBalanceAfter,
      counterPartyBalance: bobBalanceAfter
    } = getLastState();

    expect(aliceBalanceAfter).to.be.bignumber.equal(FIVE_TOKENS);
    expect(bobBalanceAfter).to.be.bignumber.equal(TEN_TOKENS);
  };

  beforeEach(async () => {
    channelStates = [];
    await instantiateContracts();
    await mintTokens(alice, aliceDeposit);
    await mintTokens(bob, bobDeposit);
    await approveChannelContract(alice, aliceDeposit);
    await approveChannelContract(bob, bobDeposit);
  });

  describe('channel without challenge period', () => {
    describe('open a channel', () => {
      const challengePeriod = '0';

      it("shouldn't open a channel with himself", async () => {
        const amount = aliceDeposit;
        const open = channel.open(tokenAddress, alice, amount, challengePeriod, {
          from: alice
        });
        await expectRevert(open, "You can't create a channel with yourself.");
      });

      it("shouldn't open a channel without tokens", async () => {
        const amount = '0';
        const open = channel.open(tokenAddress, bob, amount, challengePeriod, { from: alice });
        await expectRevert(open, "You can't create a payment channel without tokens.");
      });

      it("shouldn't open a channel without token transferFrom approval", async () => {
        await token.decreaseAllowance(channelAddress, aliceDeposit, { from: alice });
        const amount = aliceDeposit;
        const open = channel.open(tokenAddress, bob, amount, challengePeriod, { from: alice });

        // Note: That message is being sent by ERC20 contract during transferFrom call
        await expectRevert(open, 'SafeMath: subtraction overflow.');
      });

      it("shouldn't open a channel with insufficient tokens", async () => {
        const balance = await token.balanceOf(carl);
        expect(balance).to.be.bignumber.equal(new BN(0));

        const amount = '10';
        const open = channel.open(tokenAddress, bob, amount, challengePeriod, { from: carl });

        // Note: That message is being sent by ERC20 contract during transferFrom call
        await expectRevert(open, 'SafeMath: subtraction overflow.');
      });

      it('should open a channel without challenge period', openChannel);
    });

    describe('join to a channel', () => {
      beforeEach('', async () => {
        await openChannel();
      });

      it("shouldn't join to a invalid channel", async () => {
        const invalidChannelId = '0xABCDEF';
        const amount = bobDeposit;
        const join = channel.join(invalidChannelId, amount, { from: bob });
        await expectRevert(join, 'No channel with that channelId exists.');
      });

      it("shouldn't join if the user isn't the counter party", async () => {
        const { channelId } = channelStates.pop();
        const amount = toWei('1', 'ether');

        await mintTokens(carl, amount);
        await approveChannelContract(carl, amount);

        const join = channel.join(channelId, amount, { from: carl });
        await expectRevert(join, "The channel creator did'nt specify you as the counter party.");
      });

      it('bob should join to the channel without funds', async () => {
        const { channelId } = channelStates.pop();
        const amount = '0';

        const tx = await channel.join(channelId, amount, { from: bob });
        expectEvent(tx, 'CounterPartyJoined', { channelId });
      });

      it('bob should join to the channel', joinChannel);

      it("shouldn't join twice", async () => {
        await joinChannel();
        await mintTokens(bob, bobDeposit);
        await approveChannelContract(bob, bobDeposit);
        await expectRevert(joinChannel(), 'You cannot join to the channel twice.');
      });

      it("shouldn't join to a closed", async () => {
        await joinChannel();
        await offChainTransfers();
        const lastState = getLastState();
        await closeChannel(lastState, alice);
        await expectRevert(joinChannel(), 'The channel should be opened.');
      });
    });

    describe('close a channel', () => {
      beforeEach('', async () => {
        await openChannel();
        await joinChannel();
        await offChainTransfers();
      });

      it("the channel shouldn't be closed by a third-party", async () => {
        const state = getLastState();
        await expectRevert(closeChannel(state, carl), 'You are not a participant in this channel.');
      });

      describe("the channel shouldn't be closed using wrong signatures", async () => {
        it('invalid party signature', async () => {
          let state = getLastState();
          const partySignature = '0xA';
          state = { ...state, partySignature };
          await expectRevert(closeChannel(state, alice), 'The partySignature is invalid.');
        });

        it('invalid counter party signature', async () => {
          let state = getLastState();
          const counterPartySignature = '0xA';
          state = { ...state, counterPartySignature };
          await expectRevert(closeChannel(state, alice), 'The counterPartySignature is invalid.');
        });
      });

      it('the final balances should be consistent', async () => {
        const lastState = getLastState();
        let { partyBalance, counterPartyBalance } = lastState;

        partyBalance = new BN(toWei('1000', 'ether'));
        counterPartyBalance = new BN(toWei('1000', 'ether'));

        let fakeState = { ...lastState, partyBalance, counterPartyBalance };
        const { partySignature, counterPartySignature } = await signChannelState(fakeState);
        fakeState = { ...fakeState, partySignature, counterPartySignature };

        await expectRevert(
          closeChannel(fakeState, alice),
          'The law of conservation of total balances was not respected.'
        );
      });

      it('channel should be closed', async () => {
        const lastState = getLastState();
        const { partyBalance: aliceFinalBalance, counterPartyBalance: bobFinalBalance } = lastState;

        const aliceBalanceBefore = await token.balanceOf(alice);
        const bobBalanceBefore = await token.balanceOf(bob);

        await closeChannel(lastState, alice);

        const aliceBalanceAfter = await token.balanceOf(alice);
        const bobBalanceAfter = await token.balanceOf(bob);

        const expectedAliceBalance = aliceBalanceBefore.add(aliceFinalBalance);
        const expectedBobBalance = bobBalanceBefore.add(bobFinalBalance);

        expect(aliceBalanceAfter).to.be.bignumber.equal(expectedAliceBalance);
        expect(bobBalanceAfter).to.be.bignumber.equal(expectedBobBalance);
      });
    });
  });

  describe('channel with challenge period', () => {
    describe('open a channel', () => {
      it('should open a channel with challenge period', async () => {
        await openChannel(oneDayPeriod);
      });
    });

    describe('join to a channel', () => {
      beforeEach('', async () => {
        await openChannel(oneDayPeriod);
      });

      it('bob should join to the channel', joinChannel);

      it("shouldn't join to a channel with on challenge status", async () => {
        await joinChannel();
        await offChainTransfers();
        const lastState = getLastState();
        await closeChannel(lastState, alice);

        const { channelId } = lastState;
        const { status } = await channel.channels.call(channelId);
        expect(status).to.be.bignumber.equal(ChannelStatus.ON_CHALLENGE);

        await expectRevert(joinChannel(), 'The channel should be opened.');
      });
    });

    describe('close a channel', () => {
      beforeEach('', async () => {
        await openChannel(oneDayPeriod);
        await joinChannel();
        await offChainTransfers();
      });

      it('channel should be closed with the last state (nonce)', async () => {
        const lastState = getLastState();
        await closeChannel(lastState, bob);
      });

      it('channel should be closed with and older state (nonce)', async () => {
        const olderState = channelStates[channelStates.length - 3];
        await closeChannel(olderState, alice);
      });
    });

    describe('challenge', () => {
      beforeEach('', async () => {
        await openChannel(oneDayPeriod);
        await joinChannel();
        await offChainTransfers();

        const olderState = channelStates[channelStates.length - 3];
        await closeChannel(olderState, alice);
      });

      it('only participants should call the challenge function', async () => {
        const state = getLastState();
        await expectRevert(challange(state, carl), 'You are not a participant in this channel.');
      });

      it('bob should update the channel receipt using a higher nonce', async () => {
        const state = getLastState();
        const { channelId } = state;

        const tx = await challange(state, bob);

        const { status } = await channel.channels.call(channelId);
        expectEvent(tx, 'ChannelChallenged', { channelId });
        expect(status).to.be.bignumber.equal(ChannelStatus.ON_CHALLENGE);
      });
    });

    describe('redeem funds', () => {
      beforeEach('', async () => {
        await openChannel(oneDayPeriod);
        await joinChannel();
        await offChainTransfers();

        const lastState = getLastState();
        await closeChannel(lastState, bob);
      });

      it("the funds shouldn't be redeemed during the challenge period", async () => {
        const { channelId } = getLastState();
        const redeem = channel.redeem(channelId, { from: bob });
        await expectRevert(redeem, 'The challenge period should be over.');
      });

      it('the funds should be redeemed after the challenge period', async () => {
        const {
          channelId,
          partyBalance: aliceFinalBalance,
          counterPartyBalance: bobFinalBalance
        } = getLastState();

        const aliceBalanceBefore = await token.balanceOf(alice);
        const bobBalanceBefore = await token.balanceOf(bob);

        await time.increase(time.duration.days(2));

        const tx = await channel.redeem(channelId, { from: bob });
        expectEvent(tx, 'ChannelClosed', { channelId });

        const aliceBalanceAfter = await token.balanceOf(alice);
        const bobBalanceAfter = await token.balanceOf(bob);

        const expectedAliceBalance = aliceBalanceBefore.add(aliceFinalBalance);
        const expectedBobBalance = bobBalanceBefore.add(bobFinalBalance);

        expect(aliceBalanceAfter).to.be.bignumber.equal(expectedAliceBalance);
        expect(bobBalanceAfter).to.be.bignumber.equal(expectedBobBalance);
      });
    });
  });
});
