/* eslint-disable security/detect-non-literal-fs-filename */

const TokenChannels = artifacts.require('TokenChannels');
const Dai = artifacts.require('Dai');

const { BN, expectRevert } = require('openzeppelin-test-helpers');
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

contract.only('TokenChannels', accounts => {
  const [root, alice, bob, carl] = accounts;

  let dai;
  let daiAddress;
  let channel;
  let channelAddress;

  const aliceDeposit = toWei('10', 'ether');
  const bobDeposit = toWei('5', 'ether');

  const instantiateContracts = async () => {
    dai = await Dai.new();
    ({ address: daiAddress } = dai);

    channel = await TokenChannels.new();
    ({ address: channelAddress } = channel);
  };

  const mintTokens = async (to, amount) => {
    const balanceBefore = await dai.balanceOf(to);
    expect(balanceBefore).to.be.bignumber.equal(new BN(0));

    await dai.mint(to, amount, { from: root });

    const balanceAfter = await dai.balanceOf(to);

    expect(balanceAfter).to.be.bignumber.equal(new BN(amount));
  };

  const approveChannelContract = async (from, amount) => {
    const tx = await dai.approve(channelAddress, amount, { from });
    expectEvent(tx, 'Approval');
  };

  const openChannelSucessfully = async (challengePeriod = 0) => {
    const amount = aliceDeposit;
    const tx = await channel.open(daiAddress, bob, amount, challengePeriod, { from: alice });

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

    expect(initialState.status).to.be.bignumber.equal(ChannelStatus.OPEN);

    channelStates.push(initialState);
  };

  const joinChannelSucessfully = async () => {
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
  };

  beforeEach(async () => {
    channelStates = [];
    await instantiateContracts();
    await mintTokens(alice, aliceDeposit);
    await mintTokens(bob, bobDeposit);
    await approveChannelContract(alice, aliceDeposit);
    await approveChannelContract(bob, bobDeposit);
  });

  describe('open a channel without challenge period', () => {
    const challengePeriod = '0';

    it("shouldn't open a channel with himself", async () => {
      const amount = aliceDeposit;
      const openChannel = channel.open(daiAddress, alice, amount, challengePeriod, { from: alice });
      await expectRevert(openChannel, "You can't create a channel with yourself");
    });

    it("shouldn't open a channel without tokens", async () => {
      const amount = '0';
      const openChannel = channel.open(daiAddress, bob, amount, challengePeriod, { from: alice });
      await expectRevert(openChannel, "You can't create a payment channel without tokens");
    });

    it("shouldn't open a channel with insufficient tokens", async () => {
      const balance = await dai.balanceOf(carl);
      expect(balance).to.be.bignumber.equal(new BN(0));

      const amount = '10';
      const openChannel = channel.open(daiAddress, bob, amount, challengePeriod, { from: carl });

      // Note: That message is being sent by ERC20 contract during transferFrom call
      await expectRevert(openChannel, 'SafeMath: subtraction overflow.');
    });

    it('should open a channel', openChannelSucessfully);
  });

  describe('join to a channel', () => {
    beforeEach('', async () => {
      await openChannelSucessfully();
    });

    it("shouldn't join to a invalid channel", async () => {
      const invalidChannelId = '0xABCDEF';
      const amount = bobDeposit;
      const joinChannel = channel.join(invalidChannelId, amount, { from: bob });
      await expectRevert(joinChannel, 'No channel with that channelId exists');
    });

    it("shouldn't join if the user isn't the counter party", async () => {
      const { channelId } = channelStates.pop();
      const amount = toWei('1', 'ether');

      await mintTokens(carl, amount);
      await approveChannelContract(carl, amount);

      const joinChannel = channel.join(channelId, amount, { from: carl });
      await expectRevert(
        joinChannel,
        "The channel creator did'nt specify you as the counter party"
      );
    });

    it('bob should join to the channel without funds', async () => {
      const { channelId } = channelStates.pop();
      const amount = '0';

      const tx = await channel.join(channelId, amount, { from: bob });
      expectEvent(tx, 'CounterPartyJoined', { channelId });
    });

    it('bob should join to the channel', joinChannelSucessfully);

    it.skip("shouldn't join twice", async () => {
      await joinChannelSucessfully();
      await mintTokens(bob, bobDeposit);
      await joinChannelSucessfully();
    });

    it.skip("shouldn't join to a closed or closing channel", async () => {});
  });

  describe('close a channel', () => {
    beforeEach('', async () => {
      await openChannelSucessfully();
      await joinChannelSucessfully();

      // should do an off-chain transfer
      const value = new BN(toWei('9', 'ether'));
      await offChainTransfer(alice, bob, value);
    });

    it("the channel shouldn't be closed by a third-party", async () => {
      const {
        channelId,
        partyBalance,
        counterPartyBalance,
        nonce,
        partySignature,
        counterPartySignature
      } = getLastState();

      const closeChannel = channel.close(
        channelId,
        `${nonce}`,
        `${partyBalance}`,
        `${counterPartyBalance}`,
        partySignature,
        counterPartySignature,
        { from: carl }
      );

      await expectRevert(closeChannel, 'You are not a participant in this channel');
    });

    describe("the channel shouldn't be closed using wrong signatures", async () => {
      it('invalid party signature', async () => {
        const {
          channelId,
          partyBalance,
          counterPartyBalance,
          nonce,
          counterPartySignature
        } = getLastState();

        const partySignature = '0xA';

        const closeChannel = channel.close(
          channelId,
          `${nonce}`,
          `${partyBalance}`,
          `${counterPartyBalance}`,
          partySignature,
          counterPartySignature,
          { from: alice }
        );

        await expectRevert(closeChannel, 'The partySignature is invalid');
      });

      it('invalid counter party signature', async () => {
        const {
          channelId,
          partyBalance,
          counterPartyBalance,
          nonce,
          partySignature
        } = getLastState();

        const counterPartySignature = '0xA';

        const closeChannel = channel.close(
          channelId,
          `${nonce}`,
          `${partyBalance}`,
          `${counterPartyBalance}`,
          partySignature,
          counterPartySignature,
          { from: alice }
        );

        await expectRevert(closeChannel, 'The counterPartySignature is invalid');
      });
    });

    it('the final balances should be consistent', async () => {
      const lastState = getLastState();
      const { channelId, nonce } = lastState;
      let { partyBalance, counterPartyBalance } = lastState;

      partyBalance = new BN(toWei('1000', 'ether'));
      counterPartyBalance = new BN(toWei('1000', 'ether'));

      const fakeState = { ...lastState, partyBalance, counterPartyBalance };
      const { partySignature, counterPartySignature } = await signChannelState(fakeState);

      const closeChannel = channel.close(
        channelId,
        `${nonce}`,
        `${partyBalance}`,
        `${counterPartyBalance}`,
        partySignature,
        counterPartySignature,
        { from: alice }
      );

      await expectRevert(
        closeChannel,
        'The law of conservation of total balances was not respected'
      );
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

      const channelState = await channel.channels.call(channelId);

      expect(channelState.status).to.be.bignumber.equal(ChannelStatus.CLOSED);

      const aliceBalanceAfter = await dai.balanceOf(alice);
      const bobBalanceAfter = await dai.balanceOf(bob);

      const expectedAliceBalance = aliceBalanceBefore.add(aliceFinalBalance);
      const expectedBobBalance = bobBalanceBefore.add(bobFinalBalance);

      expect(aliceBalanceAfter).to.be.bignumber.equal(expectedAliceBalance);
      expect(bobBalanceAfter).to.be.bignumber.equal(expectedBobBalance);
    });
  });
});
