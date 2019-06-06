pragma solidity 0.5.8;

import "openzeppelin-solidity/contracts/cryptography/ECDSA.sol";
import "openzeppelin-solidity/contracts/math/SafeMath.sol";

// TODO
//
// Rename vars
// Use SafeMath
// Use modifers
//
contract TokenChannels {
    using SafeMath for uint256;
    using ECDSA for bytes32;

    // the data structure for the channel
    struct Channel {
        bytes32 channelId;
        address address0;
        address address1;
        uint balance0;
        uint balance1;
        uint sequenceNumber;
    }

    // channels by Id
    mapping(bytes32 => Channel) channels;

    event ChannelOpened(bytes32 channelId);
    event CounterPartyJoined(bytes32 channelId);
    event ChannelClosed(bytes32 channelId);

    // TODO: Generate channelId
    function open(address address1, uint value) public payable {


        require(msg.sender != address1, "you cant create a channel with yourself");
        require(value != 0, "you can't create a payment channel with no money");
        require(msg.value == value, "incorrect funds");

        // create a channel with the id being a hash of the data
        bytes32 channelId = keccak256(
            abi.encodePacked(msg.sender, address1, block.timestamp)
        );

        Channel memory channel = Channel(
            channelId,
            msg.sender, // address0
            address1, // address1
            msg.value, // balance0
            0, // balance1
            0 // sequence number
        );

        channels[channelId] = channel;

        emit ChannelOpened(channelId);
    }

    function join(bytes32 channelId) public payable {
        require(channels[channelId].channelId != 0, "no channel with that channelId exists");
        require(
            channels[channelId].address1 == msg.sender,
            "the channel creator did not specify you as the second participant"
        );
        require(msg.value != 0, "incorrect funds");

        channels[channelId].balance1 = msg.value;

        emit CounterPartyJoined(channelId);
    }

    function close(
        bytes32 channelId,
        uint sequenceNumber,
        uint balance0,
        uint balance1,
        bytes memory signature0,
        bytes memory signature1
    ) public {
        require(channels[channelId].channelId != 0, "no channel with that channelId exists");

        // copies the channel from storage into memory
        Channel memory channel = channels[channelId];

        require(
            channel.address0 == msg.sender || channel.address1 == msg.sender,
            "you are not a participant in this channel"
        );

        // sha3
        bytes32 stateHash = keccak256(
            abi.encodePacked(channelId, balance0, balance1, sequenceNumber)
        );

        require(ecverify(stateHash, signature0, channel.address0), "signature0 invalid");

        require(ecverify(stateHash, signature1, channel.address1), "signature1 invalid");

        // TODO: Remove-me?
        require(sequenceNumber > channel.sequenceNumber, "sequence number too low");

        require(
            (balance0 + balance1) == (channel.balance0 + channel.balance1),
            "the law of conservation of total balances was not respected"
        );

        // delete channel storage first to prevent re-entry
        delete channels[channelId];

        address payable a0 = address(uint160(channel.address0));
        address payable a1 = address(uint160(channel.address1));

        a0.transfer(balance0);
        a1.transfer(balance1);

        emit ChannelClosed(channelId);
    }

    function ecverify(bytes32 hash, bytes memory sig, address signer) internal pure returns (bool b) {
        bytes32 ethHash = hash.toEthSignedMessageHash();
        return ethHash.recover(sig) == signer;
    }

}
