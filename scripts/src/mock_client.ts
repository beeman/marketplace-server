import * as axios from "axios";
import * as uuid4 from "uuid4";
import * as jsonwebtoken from "jsonwebtoken";
import { Offer, OfferList } from "./public/services/offers";
import { OpenOrder, Order, OrderList } from "./public/services/orders";
import { Poll, Tutorial, TUTORIAL_DESCRIPTION } from "./public/services/offer_contents";
import { delay, generateId, retry } from "./utils";
import { Application } from "./models/applications";
import { ApiError } from "./public/middleware";
import * as StellarSdk from "stellar-sdk";
import { AuthToken } from "./public/services/users";
import {
	Operation,
	xdr,
	Memo,
	TransactionRecord,
	TransactionError,
	PaymentOperationRecord,
	CollectionPage, OperationRecord
} from "stellar-sdk";
import { CompletedPayment, PaymentPayload } from "./internal/services";
import { SpendPayloadOffer } from "./public/services/applications";
import { JWTValue } from "./models/offers";
import { JWTContent } from "./public/jwt";
import * as expect from "expect";

// const BASE = "https://api.kinmarketplace.com"; // production - XXX get this from env var?
const BASE = "http://localhost:3000";
const JWT_SERVICE_BASE = "http://localhost:3002";

class Stellar {
	public static MEMO_VERSION = 1;
	public server!: StellarSdk.Server; // StellarSdk.Server
	public kinAsset!: StellarSdk.Asset; // StellarSdk.Asset
	public constructor(network: "production" | "testnet") {
		if (network === "testnet") {
			StellarSdk.Network.useTestNetwork();
			this.server = new StellarSdk.Server("https://horizon-testnet.stellar.org");
			this.kinAsset = new StellarSdk.Asset("KIN", "GCKG5WGBIJP74UDNRIRDFGENNIH5Y3KBI5IHREFAJKV4MQXLELT7EX6V");
		} // else - get production values
	}
}

const STELLAR = new Stellar("testnet");

type SignInPayload = { apiKey: string, userId: string } | { jwt: string };

function isJWT(obj: any): obj is { jwt: string } {
	return !!obj.jwt;
}

class SampleAppClient {
	public async getRegisterJWT(userId: string): Promise<string> {
		const res = await axios.default.get(JWT_SERVICE_BASE + "/register/token?user_id=" + userId);
		return res.data.jwt;
	}

	public async getSpendJWT(offerId: string): Promise<string> {
		const res = await axios.default.get(JWT_SERVICE_BASE + "/spend/token?offer_id=" + offerId);
		return res.data.jwt;
	}

	public async getOffers(): Promise<SpendPayloadOffer[]> {
		const res = await axios.default.get(JWT_SERVICE_BASE + "/offers");
		return res.data.offers;
	}

	public async isValidSignature(jwt: string): Promise<boolean> {
		const res = await axios.default.get(JWT_SERVICE_BASE + `/validate?jwt=${jwt}`);
		return res.data.is_valid;
	}
}

class Client {

	private static KinPaymentFromStellar(operation: PaymentOperationRecord, transaction: TransactionRecord): CompletedPayment {
		const [, appId, id] = transaction.memo.split("-", 3);
		return {
			id,
			app_id: appId,
			transaction_id: operation.id,
			recipient_address: operation.to,
			sender_address: operation.from,
			amount: parseInt(operation.amount, 10),
			timestamp: transaction.created_at,
		};
	}

	public readonly appId!: string;
	public authToken!: AuthToken;
	private keyPair!: StellarSdk.Keypair;

	public async register(payload: SignInPayload, walletAddress?: string) {
		const generatedWallet = !walletAddress;
		if (walletAddress) {
			if (walletAddress.startsWith("S")) {
				this.keyPair = StellarSdk.Keypair.fromSecret(walletAddress);
			} else {
				this.keyPair = StellarSdk.Keypair.fromPublicKey(walletAddress);
			}
		} else { // generate a keypair
			this.createWallet();
		}
		console.log("registering with wallet: " + this.keyPair.publicKey());

		const data = {
			device_id: "my_device",
			wallet_address: this.keyPair.publicKey(),
		};
		if (isJWT(payload)) {
			Object.assign(data, { sign_in_type: "jwt", jwt: payload.jwt });

		} else {
			Object.assign(data, { sign_in_type: "whitelist", user_id: payload.userId, api_key: payload.apiKey });
		}

		const res = await this._post("/v1/users", data);

		this.authToken = res.data;
		(this.appId as any) = this.authToken.app_id;

		if (generatedWallet) {
			const res = await this.establishTrustLine();
			console.log("trust tx hash: " + res.hash);
		}
	}

	public get isActive(): boolean {
		return this.authToken.activated;
	}

	public async pay(recipientAddress: string, amount: number, orderId: string): Promise<TransactionRecord> {
		const op = StellarSdk.Operation.payment({
			destination: recipientAddress,
			asset: STELLAR.kinAsset,
			amount: amount.toString()
		});
		const memoText = `${Stellar.MEMO_VERSION}-${this.appId}-${orderId}`;
		return await this.stellarOperation(op, memoText);
	}

	public async getPayments(): Promise<CollectionPage<PaymentOperationRecord>> {
		return await STELLAR.server
			.payments()
			.forAccount(this.keyPair.publicKey())
			.order("desc")
			.limit(10)
			.call();
	}

	public async getKinPayments(): Promise<CompletedPayment[]> {
		const payments = await this.getPayments();
		return (await Promise.all(
			payments.records
				.map(async payment => {
					const transaction = await payment.transaction();
					return Client.KinPaymentFromStellar(payment, transaction);
				})
		)).filter(payment => payment !== undefined);
	}

	public async findKinPayment(orderId: string): Promise<CompletedPayment | undefined> {
		const payments = await this.getKinPayments();
		for (const payment of payments) {
			if (payment.id === orderId) {
				return payment;
			}
		}
	}

	public async activate() {
		const res = await this._post("/v1/users/me/activate");
		this.authToken = res.data;
	}

	public async getOffers(): Promise<OfferList> {
		const res = await this._get("/v1/offers");
		return res.data as OfferList;
	}

	public async createOrder(offerId: string): Promise<OpenOrder> {
		const res = await this._post(`/v1/offers/${offerId}/orders`);
		return res.data as OpenOrder;
	}

	public async createExternalOrder(jwt: string): Promise<OpenOrder> {
		const res = await this._post(`/v1/offers/external/orders`, { jwt });
		return res.data as OpenOrder;
	}

	public async submitOrder(orderId: string, content?: string): Promise<Order> {
		const res = await this._post(`/v1/orders/${orderId}`, { content });
		return res.data as Order;
	}

	public async getOrder(orderId: string): Promise<Order> {
		const res = await this._get(`/v1/orders/${orderId}`);
		return res.data as Order;
	}

	public async cancelOrder(orderId: string): Promise<void> {
		const res = await this._delete(`/v1/orders/${orderId}`);
	}

	public async changeOrder(orderId: string, data: any): Promise<Order> {
		const res = await this._patch(`/v1/orders/${orderId}`, data);
		return res.data as Order;
	}

	public async changeOrderToFailed(orderId: string, error: string, code: number, message: string): Promise<Order> {
		const res = await this._patch(`/v1/orders/${orderId}`, { error: { error, code, message } });
		return res.data as Order;
	}

	public async getOrders(): Promise<OrderList> {
		const res = await this._get("/v1/orders");
		return res.data as OrderList;
	}

	private handleAxiosError(ex: axios.AxiosError): never {
		const apiError: ApiError = ex.response!.data;
		throw Error(`server error ${ex.response!.status}(${apiError.code}): ${apiError.error}`);
	}

	private async _delete(url: string): Promise<any> {
		try {
			return await axios.default.delete(BASE + url, this.getConfig());
		} catch (error) {
			this.handleAxiosError(error);
		}
	}

	private async _patch(url: string, data: any): Promise<any> {
		try {
			return await axios.default.patch(BASE + url, data, this.getConfig());
		} catch (error) {
			this.handleAxiosError(error);
		}
	}

	private async _get(url: string): Promise<any> {
		try {
			return await axios.default.get(BASE + url, this.getConfig());
		} catch (error) {
			this.handleAxiosError(error);
		}
	}

	private async _post(url: string, data: any = {}): Promise<any> {
		try {
			return await axios.default.post(BASE + url, data, this.getConfig());
		} catch (error) {
			this.handleAxiosError(error);
		}
	}

	private getConfig() {
		return {
			headers: {
				"x-request-id": uuid4(),
				"Authorization": this.authToken ? `Bearer ${this.authToken.token}` : "",
			},
		};
	}

	private createWallet(): void {
		this.keyPair = StellarSdk.Keypair.random();
	}

	private async stellarOperation(operation: xdr.Operation<Operation.Operation>, memoText?: string): Promise<TransactionRecord> {
		try {
			const accountResponse = await STELLAR.server.loadAccount(this.keyPair.publicKey());
			const transactionBuilder = new StellarSdk.TransactionBuilder(accountResponse);
			transactionBuilder.addOperation(operation);
			if (memoText) {
				transactionBuilder.addMemo(Memo.text(memoText));
			}
			const transaction = transactionBuilder.build();

			transaction.sign(this.keyPair);
			return await STELLAR.server.submitTransaction(transaction);
		} catch (e) {
			const err: TransactionError = e;
			throw new Error(`\nStellar Error:\ntransaction: ${err.data.extras.result_codes.transaction}` +
				`\n\toperations: ${err.data.extras.result_codes.operations.join(",")}`);
		}
	}

	private async establishTrustLine(): Promise<TransactionRecord> {
		const op = StellarSdk.Operation.changeTrust({
			asset: STELLAR.kinAsset
		});

		let error: Error | undefined;
		for (let i = 0; i < 3; i++) {
			try {
				return await this.stellarOperation(op);
			} catch (e) {
				error = e;

				if (i < 2) {
					await delay(3000);
				}
			}
		}

		throw error;
	}
}

async function didNotApproveTOS() {
	console.log("=====================================didNotApproveTOS=====================================");
	const client = new Client();

	await client.register({ apiKey: Application.SAMPLE_API_KEY, userId: "new_user_123" },
		"GDNI5XYHLGZMLDNJMX7W67NBD3743AMK7SN5BBNAEYSCBD6WIW763F2H");
	const offers = await client.getOffers();
	try {
		await client.createOrder(offers.offers[0].id);
	} catch (error) {
		return; // ok!
	}
	throw Error("expected to throw have to complete TOS");
}

async function spendFlow() {
	console.log("=====================================spend=====================================");
	const client = new Client();
	// this address is prefunded with test kin

	await client.register({ apiKey: Application.SAMPLE_API_KEY, userId: "rich_user2" },
		"SAM7Z6F3SHWWGXDIK77GIXZXPNBI2ABWX5MUITYHAQTOEG64AUSXD6SR");
	await client.activate();
	const offers = await client.getOffers();

	let selectedOffer: Offer | undefined;

	for (const offer of offers.offers.reverse()) {
		if (offer.offer_type === "spend") {
			selectedOffer = offer;
		}
	}
	if (!selectedOffer) {
		throw new Error("did not find a spend offer");
	}

	console.log(`requesting order for offer: ${selectedOffer.id}: ${selectedOffer.content}`);
	const openOrder = await client.createOrder(selectedOffer.id);
	console.log(`got open order`, openOrder);
	// pay for the offer
	await client.submitOrder(openOrder.id); // XXX allow the flow where this line is missing
	const res = await client.pay(selectedOffer.blockchain_data.recipient_address!, selectedOffer.amount, openOrder.id);

	console.log("pay result hash: " + res.hash);

	// poll on order payment
	const order = await retry(() => client.getOrder(openOrder.id), order => order.status === "completed", "order did not turn completed");

	console.log(`completion date: ${order.completion_date}`);

	console.log(`got order after submit`, order);
	console.log(`order history`, (await client.getOrders()).orders.slice(0, 2));
}

function isValidPayment(order: Order, appId: string, payment: CompletedPayment): boolean {
	return (
		order.amount === payment.amount &&
		order.id === payment.id &&
		order.blockchain_data!.transaction_id === payment.transaction_id &&
		order.blockchain_data!.recipient_address === payment.recipient_address &&
		order.blockchain_data!.sender_address === payment.sender_address &&
		appId === payment.app_id);
}

async function earnFlow() {
	console.log("=====================================earn=====================================");
	const client = new Client();
	await client.register({ apiKey: Application.SAMPLE_API_KEY, userId: "doody98ds4" },
		"GDZTQSCJQJS4TOWDKMCU5FCDINL2AUIQAKNNLW2H2OCHTC4W2F4YKVLZ");
	await client.activate();

	const offers = await client.getOffers();

	let selectedOffer: Offer | undefined;

	for (const offer of offers.offers.reverse()) {
		if (offer.offer_type === "earn") {
			selectedOffer = offer;
		}
	}

	if (!selectedOffer) {
		throw new Error("no earn offer");
	}

	console.log(`requesting order for offer: ${selectedOffer.id}: ${selectedOffer.content}`);
	const openOrder = await client.createOrder(selectedOffer.id);
	console.log(`got open order`, openOrder);

	// fill in the poll
	console.log("poll " + selectedOffer.content);
	const poll: Poll = JSON.parse(selectedOffer.content);

	// TODO: Lior, you need to fix this.
	/*const content = JSON.stringify({ [poll.pages[0].question.id]: poll.pages[0].question.answers[0] });
	console.log("answers " + content);

	await client.submitOrder(openOrder.id, content);*/
	await client.submitOrder(openOrder.id, "{}");

	// poll on order payment
	const order = await retry(() => client.getOrder(openOrder.id), order => order.status === "completed", "order did not turn completed");

	console.log(`completion date: ${order.completion_date}`);

	// check order on blockchain
	const payment = (await retry(() => client.findKinPayment(order.id), payment => !!payment, "failed to find payment on blockchain"))!;

	console.log(`got order after submit`, order);
	console.log(`order history`, (await client.getOrders()).orders.slice(0, 2));
	console.log(`payment on blockchain:`, payment);

	if (!isValidPayment(order, client.appId, payment)) {
		throw new Error("payment is not valid - different than order");
	}

}

async function earnTutorial() {
	console.log("=====================================earnTutorial=====================================");
	const client = new Client();
	await client.register({ apiKey: Application.SAMPLE_API_KEY, userId: "doody98ds" },
		"GDNI5XYHLGZMLDNJMX7W67NBD3743AMK7SN5BBNAEYSCBD6WIW763F2H");
	await client.activate();

	const offers = await client.getOffers();

	let selectedOffer: Offer | undefined;

	for (const offer of offers.offers) {
		if (offer.description === TUTORIAL_DESCRIPTION) {
			console.log("offer", offer);
			selectedOffer = offer;
		}
	}

	if (!selectedOffer) {
		throw new Error("no tutorial found");
	}

	console.log(`requesting order for offer: ${selectedOffer.id}: ${selectedOffer.content.slice(0, 100)}`);
	const openOrder = await client.createOrder(selectedOffer.id);
	console.log(`got order ${openOrder.id}`);

	// fill in the poll
	console.log("poll " + selectedOffer.content.slice(0, 100));
	const poll: Tutorial = JSON.parse(selectedOffer.content);

	const content = JSON.stringify({});
	console.log("answers " + content);

	await client.submitOrder(openOrder.id, content);

	// poll on order payment
	const order = await retry(() => client.getOrder(openOrder.id), order => order.status === "completed", "order did not turn completed");

	console.log(`completion date: ${order.completion_date}`);
	console.log(`got order after submit`, order);
	console.log(`order history`, (await client.getOrders()).orders.slice(0, 2));
}

async function testRegisterNewUser() {
	console.log("=====================================testRegisterNewUser=====================================");
	const client = new Client();
	await client.register({ apiKey: Application.SAMPLE_API_KEY, userId: generateId() });
}

async function justPay() {
	console.log("=====================================justPay=====================================");
	const client = new Client();
	await client.register({ apiKey: Application.SAMPLE_API_KEY, userId: generateId() });
	await client.pay("GCZ72HXIUSDXEEL2RVZR6PXHGYU7S3RMQQ4O6UVIXWOU4OUVNIQKQR2X", 1, "SOME_ORDER");

}

async function registerJWT() {
	console.log("=====================================registerJWT=====================================");

	const client = new Client();
	const userId = generateId();
	const appClient = new SampleAppClient();
	const jwt = await appClient.getRegisterJWT(userId);
	await client.register({ jwt });
}

async function nativeSpendFlow() {
	console.log("=====================================nativeSpendFlow=====================================");

	const client = new Client();
	// this address is prefunded with test kin
	const userId = "rich_user:" + generateId();
	const appClient = new SampleAppClient();
	const jwt = await appClient.getRegisterJWT(userId);

	await client.register({ jwt },
		"SAM7Z6F3SHWWGXDIK77GIXZXPNBI2ABWX5MUITYHAQTOEG64AUSXD6SR");
	await client.activate();

	const selectedOffer = (await appClient.getOffers())[0];
	const offerJwt = await appClient.getSpendJWT(selectedOffer.id);
	console.log(`requesting order for offer: ${selectedOffer.id}: ${offerJwt}`);

	const openOrder = await client.createExternalOrder(offerJwt);
	console.log(`got open order`, openOrder);

	expect(openOrder.amount).toBe(selectedOffer.amount);
	expect(openOrder.blockchain_data.recipient_address).toBe(selectedOffer.wallet_address);
	expect(openOrder.offer_id).toBe(selectedOffer.id);

	// pay for the offer
	const res = await client.pay(selectedOffer.wallet_address, selectedOffer.amount, openOrder.id);
	console.log("pay result hash: " + res.hash);
	await client.submitOrder(openOrder.id);

	// poll on order payment
	const order = await retry(() => client.getOrder(openOrder.id), order => order.status === "completed", "order did not turn completed");

	console.log(`completion date: ${order.completion_date}`);

	// find payment on blockchain
	const payment = (await retry(() => client.findKinPayment(order.id), payment => !!payment, "failed to find payment on blockchain"))!;

	expect(payment).toBeDefined();

	console.log(`payment on blockchain:`, payment);
	expect(isValidPayment(order, client.appId, payment)).toBeTruthy();
	console.log(`got order after submit`, order);
	console.log(`order history`, (await client.getOrders()).orders.slice(0, 2));

	expect(order.result!.type).toBe("confirm_payment");
	const paymentJwt = (order.result! as JWTValue).jwt;
	const jwtPayload = jsonwebtoken.decode(paymentJwt, { complete: true }) as JWTContent<PaymentPayload>;
	expect(jwtPayload.payload.payment.offer_id).toBe(order.offer_id);
	expect(jwtPayload.payload.payment.user_id).toBe(userId);
	expect(jwtPayload.header.kid).toBeDefined();
	// verify using kin public key
	expect(await appClient.isValidSignature(paymentJwt)).toBeTruthy();
}

async function tryToNativeSpendTwice() {
	console.log("=====================================tryToNativeSpendTwice=====================================");
	const client = new Client();
	const userId = "rich_user:" + generateId();
	const appClient = new SampleAppClient();
	const jwt = await appClient.getRegisterJWT(userId);

	await client.register({ jwt },
		"SAM7Z6F3SHWWGXDIK77GIXZXPNBI2ABWX5MUITYHAQTOEG64AUSXD6SR");
	await client.activate();

	const selectedOffer = (await appClient.getOffers())[0];
	const offerJwt = await appClient.getSpendJWT(selectedOffer.id);
	const openOrder = await client.createExternalOrder(offerJwt);
	console.log(`created order`, openOrder.id, `for offer`, selectedOffer.id);
	// pay for the offer
	const res = await client.pay(selectedOffer.wallet_address, selectedOffer.amount, openOrder.id);
	await client.submitOrder(openOrder.id);

	// poll on order payment
	const order = await retry(() => client.getOrder(openOrder.id), order => order.status === "completed", "order did not turn completed");

	console.log(`completed order`, order.id);
	const offerJwt2 = await appClient.getSpendJWT(selectedOffer.id);
	// should not allow to create a new order
	console.log(`expecting error for new order`, selectedOffer.id);
	try {
		await client.createExternalOrder(offerJwt2);
		throw new Error("should not allow to create more than one order");
	} catch (e) {
		// ok
	}
}

async function main() {
	await earnFlow();
	// await didNotApproveTOS();
	// await testRegisterNewUser();
	// await earnTutorial();
	// await spendFlow();
	// await justPay();
	// await registerJWT();
	await nativeSpendFlow();
	// await tryToNativeSpendTwice();
}

main()
	.then(() => console.log("done"))
	.catch(err => {
		console.log(err.message + "\n" + err.stack);
	});
