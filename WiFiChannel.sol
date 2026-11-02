// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// Canal de paiement unidirectionnel : le payeur dépose, signe des montants cumulés (EIP-712),
/// le bénéficiaire encaisse le plus élevé. Contestation de 24 h en cas de fermeture unilatérale.
contract WiFiChannel is EIP712, ReentrancyGuard {
    using ECDSA for bytes32;

    struct Channel {
        address payer;
        address payee;
        uint256 deposit;
        uint256 withdrawn;       // plus haut montant signé vérifié (dû au bénéficiaire)
        uint256 disputeDeadline; // 0 = pas de fermeture unilatérale en cours
        bool closed;
    }

    mapping(bytes32 => Channel) public channels;
    uint256 public channelCount; // compteur : garantit des identifiants uniques

    bytes32 private constant PAYMENT_TYPEHASH =
        keccak256("Payment(bytes32 channelId,uint256 cumulativeAmount)");

    uint256 public constant DISPUTE_PERIOD = 24 hours;

    event ChannelOpened(bytes32 indexed channelId, address payer, address payee, uint256 deposit);
    event ChannelClosed(bytes32 indexed channelId, uint256 paidToPayee, uint256 refundedToPayer);
    event DisputeStarted(bytes32 indexed channelId, uint256 deadline);
    event DisputeUpdated(bytes32 indexed channelId, uint256 cumulativeAmount);

    constructor() EIP712("WiFiPaymentChannel", "1") {}

    function openChannel(address payee) external payable returns (bytes32 channelId) {
        require(msg.value > 0, "deposit required");
        require(payee != address(0), "invalid payee");
        channelId = keccak256(abi.encode(msg.sender, payee, channelCount++));
        channels[channelId] = Channel(msg.sender, payee, msg.value, 0, 0, false);
        emit ChannelOpened(channelId, msg.sender, payee, msg.value);
    }

    /// Règlement immédiat. Réservé au bénéficiaire : lui seul choisit le reçu à présenter,
    /// donc le payeur ne peut pas clôturer avec un ancien reçu moins élevé.
    function closeCooperative(bytes32 channelId, uint256 cumulativeAmount, bytes calldata signature)
        external
        nonReentrant
    {
        Channel storage ch = channels[channelId];
        require(!ch.closed, "already closed");
        require(msg.sender == ch.payee, "only payee");
        require(cumulativeAmount <= ch.deposit, "amount > deposit");
        require(cumulativeAmount >= ch.withdrawn, "amount < withdrawn");
        require(_signer(channelId, cumulativeAmount, signature) == ch.payer, "invalid signature");

        ch.withdrawn = cumulativeAmount;
        _settle(channelId, ch);
    }

    /// Fermeture unilatérale : démarre la période de contestation (payeur ou bénéficiaire)
    function startUnilateralClose(bytes32 channelId) external {
        Channel storage ch = channels[channelId];
        require(!ch.closed && ch.disputeDeadline == 0, "already closing");
        require(msg.sender == ch.payer || msg.sender == ch.payee, "not party");
        ch.disputeDeadline = block.timestamp + DISPUTE_PERIOD;
        emit DisputeStarted(channelId, ch.disputeDeadline);
    }

    /// Pendant le délai, un reçu signé plus élevé remplace le précédent
    function disputeWithSignature(bytes32 channelId, uint256 cumulativeAmount, bytes calldata signature)
        external
    {
        Channel storage ch = channels[channelId];
        require(!ch.closed && ch.disputeDeadline != 0 && block.timestamp < ch.disputeDeadline, "not in dispute");
        require(cumulativeAmount <= ch.deposit && cumulativeAmount > ch.withdrawn, "bad amount");
        require(_signer(channelId, cumulativeAmount, signature) == ch.payer, "invalid signature");

        ch.withdrawn = cumulativeAmount;
        emit DisputeUpdated(channelId, cumulativeAmount);
    }

    /// Après le délai, répartit les fonds selon le plus haut reçu soumis
    function finalizeUnilateralClose(bytes32 channelId) external nonReentrant {
        Channel storage ch = channels[channelId];
        require(!ch.closed && ch.disputeDeadline != 0 && block.timestamp >= ch.disputeDeadline, "not ready");
        _settle(channelId, ch);
    }

    function _signer(bytes32 channelId, uint256 amount, bytes calldata sig) private view returns (address) {
        return _hashTypedDataV4(keccak256(abi.encode(PAYMENT_TYPEHASH, channelId, amount))).recover(sig);
    }

    function _settle(bytes32 channelId, Channel storage ch) private {
        ch.closed = true; // effet avant interactions
        uint256 toPayee = ch.withdrawn;
        uint256 refund = ch.deposit - toPayee;
        if (toPayee > 0) {
            (bool ok1, ) = payable(ch.payee).call{value: toPayee}("");
            require(ok1, "transfer failed");
        }
        if (refund > 0) {
            (bool ok2, ) = payable(ch.payer).call{value: refund}("");
            require(ok2, "transfer failed");
        }
        emit ChannelClosed(channelId, toPayee, refund);
    }
}
