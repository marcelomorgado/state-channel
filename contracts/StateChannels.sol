pragma solidity 0.5.8;


contract ECVerify {
    event LogNum(uint8 num);
    event LogNum256(uint256 num);
    event LogBool(bool b);
    function ecrecovery(bytes32 hash, bytes memory sig) public returns (address) {
        bytes32 r;
        bytes32 s;
        uint8 v;

        // FIXME: Should this throw, or return 0?
        require(sig.length == 65, "");

        // The signature format is a compact form of:
        //   {bytes32 r}{bytes32 s}{uint8 v}
        // Compact means, uint8 is not padded to 32 bytes.
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := mload(add(sig, 65))
        }

        // old geth sends a `v` value of [0,1], while the new, in line with the YP sends [27,28]
        if (v < 27)
          v += 27;

        return ecrecover(hash, v, r, s);
    }

    function ecverify(bytes32 hash, bytes memory sig, address signer) public returns (bool b) {
        b = ecrecovery(hash, sig) == signer;
        emit LogBool(b);
        return b;
    }
}


contract StateChannels is ECVerify {
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

    // TODO: Generate channelId
    function open(bytes32 channelId, address address1, uint value) public payable {
        require(
            channels[channelId].channelId != channelId,
            "channel with that channelId already exists"
        );
        require(msg.sender != address1, "you cant create a channel with yourself");
        require(value != 0, "you can't create a payment channel with no money");
        require(msg.value == value, "incorrect funds");

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

        require(channel.address0 == msg.sender || channel.address1 == msg.sender, "you are not a participant in this channel");

        // sha3
        bytes32 stateHash = keccak256(abi.encodePacked(
            channelId,
            balance0,
            balance1,
            sequenceNumber
        ));

        require(ecverify(stateHash, signature0, channel.address0), "signature0 invalid");

        require(ecverify(stateHash, signature1, channel.address1), "signature1 invalid");

        require(sequenceNumber > channel.sequenceNumber, "sequence number too low");

        require((balance0 + balance1) == (channel.balance0 + channel.balance1), "the law of conservation of total balances was not respected");

        // delete channel storage first to prevent re-entry
        delete channels[channelId];

        address payable a0 = address(uint160(channel.address0));
        address payable a1 = address(uint160(channel.address1));

        a0.transfer(balance0);
        a1.transfer(balance1);
    }
}

