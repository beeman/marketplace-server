import { LoggerInstance } from "winston";

import * as metrics from "../metrics";
import * as db from "../models/orders";
import { Asset, Offer, OrderValue } from "../models/offers";
import { pick, removeDuplicates } from "../utils";
import { setWatcherEndpoint, Watcher } from "../public/services/payment";

import { sign as signJWT } from "./jwt";
import { Order } from "../models/orders";
import { User } from "../models/users";

export interface CompletedPayment {
	id: string;
	app_id: string;
	transaction_id: string;
	recipient_address: string;
	sender_address: string;
	amount: number;
	timestamp: string;
}

export type PaymentPayload = {
	payment: {
		date: number;
		user_id: string;
		offer_id: string;
	}
};

async function getPaymentJWT(order: Order): Promise<OrderValue> {
	const user: User = (await User.findOneById(order.userId))!;
	const payload: PaymentPayload = {
		payment: {
			date: Date.now(),
			user_id: user.appUserId,
			offer_id: order.offerId
		}
	};

	return {
		type: "confirm_payment",
		jwt: signJWT("confirm_payment", payload)
	};
}

export async function paymentComplete(payment: CompletedPayment, logger: LoggerInstance) {
	const order = await db.Order.findOneById(payment.id);
	if (!order) {
		logger.error(`received payment for unknown order id ${ payment.id }`);
		return;
	}

	if (order.status === "completed") {
		logger.warn(`received payment callback for already completed order ${ payment.id }`);
		return;
	}

	// validate payment
	if (order.amount !== payment.amount) {
		logger.error(`payment <${ payment.id }, ${ payment.transaction_id }>` +
			`amount mismatch ${ order.amount } !== ${ payment.amount }`);
		// 2. don't complete the transaction? complete only if the server got more than expected?
		// TODO: report to error reporting service
		order.error = { code: 1113, error: "wrong_amount", message: "amount on blockchain does not match order" };
		order.setStatus("failed");
		await order.save();
		return;
	}

	if (order.blockchainData!.recipient_address !== payment.recipient_address) {
		logger.error(`payment <${ payment.id }, ${ payment.transaction_id }>` +
			`addresses recipient mismatch ${ order.blockchainData!.recipient_address } !== ${ payment.recipient_address }`);

		// TODO: report to error reporting service
		order.error = {
			code: 1112,
			error: "wrong_address",
			message: "recipient address on blockchain does not match order"
		};
		order.setStatus("failed");
		await order.save();
		return;
	}

	if (order.blockchainData!.sender_address !== payment.sender_address) {
		logger.error(`payment <${ payment.id }, ${ payment.transaction_id }>` +
			`addresses sender mismatch ${ order.blockchainData!.sender_address } !== ${ payment.sender_address }`);
		// TODO: report to error reporting service
		order.error = {
			code: 1111,
			error: "wrong_address",
			message: `sender address on blockchain does not match order`
		};
		order.setStatus("failed");
		await order.save();
		return;
	}

	order.blockchainData = pick(payment, "transaction_id", "sender_address", "recipient_address");

	if (order.type === "spend") {
		if (order.isMarketplaceOrder()) {
			// XXX can we call findOne?
			const asset = await Asset.findOne({ where: { offerId: order.offerId, ownerId: null } });
			if (!asset) {
				// TODO: report to error reporting service
				order.error = {
					code: 1114,
					error: "unavailable_asset",
					message: "failed to find an available asset - contact support"
				};
				order.setStatus("failed");
				await order.save();
				return;
			} else {
				order.value = asset.asOrderValue();
				asset.ownerId = order.userId;
				await asset.save();  // XXX should be in a transaction with order.save
			}
		} else if (order.isExternalOrder()) {
			order.value = await getPaymentJWT(order);
		}
	} else {
		// earn offer - no extra steps
	}

	if (order.status !== "pending") {
		// can be either failed or opened
		logger.info("a non pending order turned completed", { order, status: order.status });
		order.error = undefined;
	}

	order.setStatus("completed");
	await order.save();

	metrics.completeOrder(order.type, order.offerId);
	logger.info(`completed order with payment <${ payment.id }, ${ payment.transaction_id }>`);
}

export async function paymentFailed(payment: CompletedPayment, reason: string, logger: LoggerInstance) {
	// TODO: doody, decide what you wanna do here

	/*const order = await db.Order.findOneById(payment.id);
	if (!order) {
		logger.error(`received payment for unknown order id ${payment.id}`);
		return;
	}

	order.blockchainData = pick(payment, "transaction_id", "sender_address", "recipient_address");
	order.completionDate = moment(payment.timestamp).toDate();
	order.status = "failed";
	order.error = { message: reason, error: "blockchain_error", code: 5001 };  // XXX where do I define this error + codes?
	await order.save();
	logger.info(`failed order with payment <${payment.id}, ${payment.transaction_id}>`);
	*/
}

/**
 * register to get callbacks for incoming payments for all the active offers
 */
export async function initPaymentCallbacks(logger: LoggerInstance): Promise<Watcher> {
	const offers = await Offer.find<Offer>({ type: "spend" }); // get all active spend offers
	// create a list of unique addresses
	const addresses = removeDuplicates(offers.map(offer => offer.blockchainData.recipient_address!));

	logger.info("setting payment watching addresses", { addresses });
	return await setWatcherEndpoint(addresses);
}
