pragma solidity 0.5.8;

import "openzeppelin-solidity/contracts/cryptography/ECDSA.sol";
import "openzeppelin-solidity/contracts/math/SafeMath.sol";
import "openzeppelin-solidity/contracts/token/ERC20/ERC20.sol";

// TODO
//
// Rename vars
// Use SafeMath
// Use modifers
// Challenge
// Offline cases (periods)
// ChannelState
// Great comments
//
contract TokenChannels {
    using SafeMath for uint256;
    using ECDSA for bytes32;

    //enum ChannelState { Open, Closing, Closed }

    struct Channel {
        bytes32 channelId;
        address tokenAddress;
        address partyAddress;
        address counterPartyAddress;
        uint partyBalance;
        uint counterPartyBalance;
        uint nonce;
    }

    // channels by Id
    mapping(bytes32 => Channel) channels;

    event ChannelOpened(bytes32 channelId);
    event CounterPartyJoined(bytes32 channelId);
    event ChannelClosed(bytes32 channelId);

    function open(address tokenAddress, address counterPartyAddress, uint256 amount) public payable {
        address partyAddress = msg.sender;

        require(partyAddress != counterPartyAddress, "you cant create a channel with yourself");
        require(amount != 0, "you can't create a payment channel with no money");

        // Note: block.timestamp isn't a strong source of entropy but it's enough safe for that use case
        bytes32 channelId = keccak256(
            abi.encodePacked(partyAddress, counterPartyAddress, block.timestamp)
        );

        Channel memory channel = Channel(
            channelId,
            tokenAddress,
            partyAddress,
            counterPartyAddress,
            amount, // partyBalance
            0, // counterPartyBalance
            0 // sequence number
        );

        ERC20 token = ERC20(tokenAddress);
        require(token.transferFrom(partyAddress, address(this), amount), "incorrect funds");

        channels[channelId] = channel;

        emit ChannelOpened(channelId);
    }

    function join(bytes32 channelId) public payable {
        require(channels[channelId].channelId != 0, "no channel with that channelId exists");
        require(
            channels[channelId].counterPartyAddress == msg.sender,
            "the channel creator did not specify you as the second participant"
        );
        require(msg.value != 0, "incorrect funds");

        channels[channelId].counterPartyBalance = msg.value;

        emit CounterPartyJoined(channelId);
    }

    function close(
        bytes32 channelId,
        uint nonce,
        uint partyBalance,
        uint counterPartyBalance,
        bytes memory signature0,
        bytes memory signature1
    ) public {
        require(channels[channelId].channelId != 0, "no channel with that channelId exists");

        // copies the channel from storage into memory
        Channel memory channel = channels[channelId];

        require(
            channel.partyAddress == msg.sender || channel.counterPartyAddress == msg.sender,
            "you are not a participant in this channel"
        );

        // sha3
        bytes32 stateHash = keccak256(
            abi.encodePacked(channelId, partyBalance, counterPartyBalance, nonce)
        );

        require(ecverify(stateHash, signature0, channel.partyAddress), "signature0 invalid");

        require(ecverify(stateHash, signature1, channel.counterPartyAddress), "signature1 invalid");

        // TODO: Remove-me?
        require(nonce > channel.nonce, "sequence number too low");

        require(
            (partyBalance + counterPartyBalance) == (channel.partyBalance + channel.counterPartyBalance),
            "the law of conservation of total balances was not respected"
        );

        // delete channel storage first to prevent re-entry
        delete channels[channelId];

        address payable a0 = address(uint160(channel.partyAddress));
        address payable a1 = address(uint160(channel.counterPartyAddress));

        a0.transfer(partyBalance);
        a1.transfer(counterPartyBalance);

        emit ChannelClosed(channelId);
    }

    function ecverify(bytes32 hash, bytes memory sig, address signer) internal pure returns (bool b) {
        bytes32 ethHash = hash.toEthSignedMessageHash();
        return ethHash.recover(sig) == signer;
    }

}
