import nodemailer from 'nodemailer'
import { humanizeAmount, zeroDecimalCurrencies } from 'medusa-core-utils'
import { NotificationService } from 'medusa-interfaces'
import Email from 'email-templates'

class SmtpService extends NotificationService {
  static identifier = 'smtp'

  /**
   * @param {Object} options - options defined in `medusa-config.js`
   *    e.g.
   {
      fromEmail: "noreply@medusajs.com",
      // this object is input directly into nodemailer.createtransport(), so anything that works there should work here
      // see: https://nodemailer.com/smtp/#1-single-connection and https://nodemailer.com/transports/
      transport: {
          sendmail: true,
          path: "/usr/sbin/sendmail",
          newline: "unix",
      },
      // an example for an office365 smtp transport:
      // {
      //     host: "smtp.office365.com",
      //     port: 587,
      //     secureConnection: false,
      //     auth: {
      //         user: process.env.EMAIL_SENDER_ADDRESS,
      //         pass: process.env.EMAIL_SENDER_PASS,
      //     },
      //     tls: {
      //         ciphers: "SSLv3",
      //     },
      //     requireTLS: true,
      // },
      // this is the path where your email templates are stored
      emailTemplatePath: "data/emailTemplates",
      // this maps the folder/template name to a medusajs event to use the right template
      // only the events that are registered here are subscribed to
      templateMap: {
          // "eventname": "templatename",
          "order.placed": "orderplaced",
      },
    }
   */
  constructor(
    {
      storeService,
      orderService,
      returnService,
      swapService,
      cartService,
      lineItemService,
      claimService,
      fulfillmentService,
      fulfillmentProviderService,
      totalsService,
      productVariantService,
    },
    options
  ) {
    super()

    this.options_ = {
      fromEmail: 'noreply@medusajs.com',
      transport: {
        sendmail: true,
        path: '/usr/sbin/sendmail',
        newline: 'unix',
      },
      emailTemplatePath: 'data/emailTemplates',
      templateMap: {
        'order.placed': 'orderplaced',
      },
      ...options,
    }

    this.fulfillmentProviderService_ = fulfillmentProviderService
    this.storeService_ = storeService
    this.lineItemService_ = lineItemService
    this.orderService_ = orderService
    this.cartService_ = cartService
    this.claimService_ = claimService
    this.returnService_ = returnService
    this.swapService_ = swapService
    this.fulfillmentService_ = fulfillmentService
    this.totalsService_ = totalsService
    this.productVariantService_ = productVariantService
    this.transporter = nodemailer.createTransport(this.options_.transport)
  }

  async fetchAttachments(event, data, attachmentGenerator) {
    switch (event) {
      case 'swap.created':
      case 'order.return_requested': {
        let attachments = []
        const { shipping_method, shipping_data } = data.return_request
        if (shipping_method) {
          const provider = shipping_method.shipping_option.provider_id

          const lbl = await this.fulfillmentProviderService_.retrieveDocuments(
            provider,
            shipping_data,
            'label'
          )

          attachments = attachments.concat(
            lbl.map((d) => ({
              name: 'return-label',
              base64: d.base_64,
              type: d.type,
            }))
          )
        }

        if (attachmentGenerator && attachmentGenerator.createReturnInvoice) {
          const base64 = await attachmentGenerator.createReturnInvoice(
            data.order,
            data.return_request.items
          )
          attachments.push({
            name: 'invoice',
            base64,
            type: 'application/pdf',
          })
        }

        return attachments
      }
      default:
        return []
    }
  }

  async fetchData(event, eventData, attachmentGenerator) {
    switch (event) {
      case 'order.return_requested':
        return this.returnRequestedData(eventData, attachmentGenerator)
      case 'swap.shipment_created':
        return this.swapShipmentCreatedData(eventData, attachmentGenerator)
      case 'claim.shipment_created':
        return this.claimShipmentCreatedData(eventData, attachmentGenerator)
      case 'order.items_returned':
        return this.itemsReturnedData(eventData, attachmentGenerator)
      case 'swap.received':
        return this.swapReceivedData(eventData, attachmentGenerator)
      case 'swap.created':
        return this.swapCreatedData(eventData, attachmentGenerator)
      case 'gift_card.created':
        return this.gcCreatedData(eventData, attachmentGenerator)
      case 'order.gift_card_created':
        return this.gcCreatedData(eventData, attachmentGenerator)
      case 'order.placed':
        return this.orderPlacedData(eventData, attachmentGenerator)
      case 'order.shipment_created':
        return this.orderShipmentCreatedData(eventData, attachmentGenerator)
      case 'order.canceled':
        return this.orderCanceledData(eventData, attachmentGenerator)
      case 'user.password_reset':
        return this.userPasswordResetData(eventData, attachmentGenerator)
      case 'customer.password_reset':
        return this.customerPasswordResetData(eventData, attachmentGenerator)
      case 'invite.created':
        return this.inviteData(eventData, attachmentGenerator)
      case 'restock-notification.restocked':
        return await this.restockNotificationData(
          eventData,
          attachmentGenerator
        )
      default:
        return eventData;
    }
  }

  getTemplateNameForEvent(eventName) {
    return this.options_.templateMap[eventName] || false
  }

  async sendNotification(event, eventData, attachmentGenerator) {
    let templateName = this.getTemplateNameForEvent(event)

    if (!templateName) {
      return {
        to: '',
        status: 'noDataFound',
        data: {},
      }
    }

    const data = await this.fetchData(event, eventData, attachmentGenerator)
    const attachments = await this.fetchAttachments(
      event,
      data,
      attachmentGenerator
    )

    const sendOptions = {
      template: templateName,
      message: {
        to: data.email,
      },
      locals: {
        data: data,
        env: process.env,
      },
    }

    if (attachments?.length) {
      sendOptions.message.attachments = attachments.map((a) => {
        return {
          content: a.base64,
          filename: a.name,
          type: a.type,
          disposition: 'attachment',
          contentId: a.name,
        }
      })
    }

    const email = new Email({
      message: {
        from: this.options_.fromEmail,
      },
      transport: this.transporter,
      views: {
        root: this.options_.emailTemplatePath,
        options: {
          extension: 'njk'
        }
      },
      send: true,
    })

    const status = await email
      .send(sendOptions)
      .then(() => 'sent')
      .catch(() => 'failed')
    delete sendOptions.message.attachments
    return {
      to: sendOptions.message.to,
      status,
      data: sendOptions.locals.data || {},
    }
  }

  async resendNotification(notification, config, attachmentGenerator) {
    let templateName = this.getTemplateNameForEvent(notification.event_name)
    if (!templateName) {
      return {
        to: notification.to,
        status: 'noTemplateFound',
        data: notification.data,
      }
    }
    const sendOptions = {
      template: templateName,
      message: {
        to: config.to || notification.to,
      },
      locals: {
        data: notification.data,
        env: process.env,
      },
    }

    const attachments = await this.fetchAttachments(
      notification.event_name,
      notification.data.dynamic_template_data,
      attachmentGenerator
    )

    sendOptions.message.attachments = attachments.map((a) => {
      return {
        content: a.base64,
        filename: a.name,
        type: a.type,
        disposition: 'attachment',
        contentId: a.name,
      }
    })

    const email = new Email({
      message: {
        from: this.options_.fromEmail,
      },
      transport: this.transporter,
      views: {
        root: this.options_.emailTemplatePath,
        options: {
          extension: 'njk'
        }
      },
      send: true,
    })
    const status = await email
      .send(sendOptions)
      .then(() => 'sent')
      .catch(() => 'failed')
    delete sendOptions.message.attachments
    return {
      to: sendOptions.message.to,
      status,
      data: sendOptions.locals.data || {},
    }
  }

  /**
   * Sends an email using smtp.
   * @param {string} templateName - name of template
   * @param {string} from - sender of email
   * @param {string} to - receiver of email
   * @param {Object} data - data to send in mail (match with template)
   * @return {Promise} result of the send operation
   */
  async sendEmail(options) {
    try {
      const email = new Email({
        message: {
          from: this.options_.fromEmail,
        },
        transport: this.transporter,
        views: {
          root: this.options_.emailTemplatePath,
          options: {
            extension: 'njk'
          }
        },
        send: true,
      })
      const status = await email
        .send({
          template: options.templateName,
          message: {
            to: options.to,
          },
          locals: {
            data: options,
            env: process.env,
          },
        })
        .then(() => 'sent')
        .catch(() => 'failed')

      return {
        to: options.to,
        status,
        data: options,
      }
    } catch (error) {
      throw error
    }
  }

  async orderShipmentCreatedData({ id, fulfillment_id }, attachmentGenerator) {
    const order = await this.orderService_.retrieve(id, {
      select: [
        'shipping_total',
        'discount_total',
        'tax_total',
        'refunded_total',
        'gift_card_total',
        'subtotal',
        'total',
        'refundable_amount',
      ],
      relations: [
        'customer',
        'billing_address',
        'shipping_address',
        'discounts',
        'discounts.rule',
        'shipping_methods',
        'shipping_methods.shipping_option',
        'payments',
        'fulfillments',
        'returns',
        'gift_cards',
        'gift_card_transactions',
      ],
    })

    const shipment = await this.fulfillmentService_.retrieve(fulfillment_id, {
      relations: ['items', 'tracking_links'],
    })

    const locale = await this.extractLocale(order)

    return {
      locale,
      order,
      date: shipment.shipped_at.toDateString(),
      email: order.email,
      fulfillment: shipment,
      tracking_links: shipment.tracking_links,
      tracking_number: shipment.tracking_numbers.join(', '),
    }
  }

  async orderCanceledData({ id }) {
    const order = await this.orderService_.retrieve(id, {
      select: [
        'shipping_total',
        'discount_total',
        'tax_total',
        'refunded_total',
        'gift_card_total',
        'subtotal',
        'total',
      ],
      relations: [
        'customer',
        'billing_address',
        'shipping_address',
        'discounts',
        'discounts.rule',
        'shipping_methods',
        'shipping_methods.shipping_option',
        'payments',
        'fulfillments',
        'returns',
        'gift_cards',
        'gift_card_transactions',
      ],
    })

    const {
      subtotal,
      tax_total,
      discount_total,
      shipping_total,
      gift_card_total,
      total,
    } = order

    const taxRate = order.tax_rate / 100
    const currencyCode = order.currency_code.toUpperCase()

    const items = this.processItems_(order.items, taxRate, currencyCode)

    let discounts = []
    if (order.discounts) {
      discounts = order.discounts.map((discount) => {
        return {
          is_giftcard: false,
          code: discount.code,
          descriptor: `${discount.rule.value}${discount.rule.type === 'percentage' ? '%' : ` ${currencyCode}`
            }`,
        }
      })
    }

    let giftCards = []
    if (order.gift_cards) {
      giftCards = order.gift_cards.map((gc) => {
        return {
          is_giftcard: true,
          code: gc.code,
          descriptor: `${gc.value} ${currencyCode}`,
        }
      })

      discounts.concat(giftCards)
    }

    const locale = await this.extractLocale(order)

    return {
      ...order,
      locale,
      has_discounts: order.discounts.length,
      has_gift_cards: order.gift_cards.length,
      date: order.created_at.toDateString(),
      items,
      discounts,
      subtotal: `${this.humanPrice_(
        subtotal * (1 + taxRate),
        currencyCode
      )} ${currencyCode}`,
      gift_card_total: `${this.humanPrice_(
        gift_card_total * (1 + taxRate),
        currencyCode
      )} ${currencyCode}`,
      tax_total: `${this.humanPrice_(tax_total, currencyCode)} ${currencyCode}`,
      discount_total: `${this.humanPrice_(
        discount_total * (1 + taxRate),
        currencyCode
      )} ${currencyCode}`,
      shipping_total: `${this.humanPrice_(
        shipping_total * (1 + taxRate),
        currencyCode
      )} ${currencyCode}`,
      total: `${this.humanPrice_(total, currencyCode)} ${currencyCode}`,
    }
  }

  async orderPlacedData({ id }) {
    const order = await this.orderService_.retrieve(id, {
      select: [
        'shipping_total',
        'discount_total',
        'tax_total',
        'refunded_total',
        'gift_card_total',
        'subtotal',
        'total',
      ],
      relations: [
        'customer',
        'billing_address',
        'shipping_address',
        'discounts',
        'discounts.rule',
        'shipping_methods',
        'shipping_methods.shipping_option',
        'payments',
        'fulfillments',
        'returns',
        'gift_cards',
        'gift_card_transactions',
      ],
    })

    const { tax_total, shipping_total, gift_card_total, total } = order

    const currencyCode = order.currency_code.toUpperCase()

    const items = await Promise.all(
      order.items.map(async (i) => {
        i.totals = await this.totalsService_.getLineItemTotals(i, order, {
          include_tax: true,
          use_tax_lines: true,
        })
        i.thumbnail = this.normalizeThumbUrl_(i.thumbnail)
        i.discounted_price = `${this.humanPrice_(
          i.totals.total / i.quantity,
          currencyCode
        )} ${currencyCode}`
        i.price = `${this.humanPrice_(
          i.totals.original_total / i.quantity,
          currencyCode
        )} ${currencyCode}`
        return i
      })
    )

    let discounts = []
    if (order.discounts) {
      discounts = order.discounts.map((discount) => {
        return {
          is_giftcard: false,
          code: discount.code,
          descriptor: `${discount.rule.value}${discount.rule.type === 'percentage' ? '%' : ` ${currencyCode}`
            }`,
        }
      })
    }

    let giftCards = []
    if (order.gift_cards) {
      giftCards = order.gift_cards.map((gc) => {
        return {
          is_giftcard: true,
          code: gc.code,
          descriptor: `${gc.value} ${currencyCode}`,
        }
      })

      discounts.concat(giftCards)
    }

    const locale = await this.extractLocale(order)

    // Includes taxes in discount amount
    const discountTotal = items.reduce((acc, i) => {
      return acc + i.totals.original_total - i.totals.total
    }, 0)

    const discounted_subtotal = items.reduce((acc, i) => {
      return acc + i.totals.total
    }, 0)
    const subtotal = items.reduce((acc, i) => {
      return acc + i.totals.original_total
    }, 0)

    const subtotal_ex_tax = items.reduce((total, i) => {
      return total + i.totals.subtotal
    }, 0)

    return {
      ...order,
      locale,
      has_discounts: order.discounts.length,
      has_gift_cards: order.gift_cards.length,
      date: order.created_at.toDateString(),
      items,
      discounts,
      subtotal_ex_tax: `${this.humanPrice_(
        subtotal_ex_tax,
        currencyCode
      )} ${currencyCode}`,
      subtotal: `${this.humanPrice_(subtotal, currencyCode)} ${currencyCode}`,
      gift_card_total: `${this.humanPrice_(
        gift_card_total,
        currencyCode
      )} ${currencyCode}`,
      tax_total: `${this.humanPrice_(tax_total, currencyCode)} ${currencyCode}`,
      discount_total: `${this.humanPrice_(
        discountTotal,
        currencyCode
      )} ${currencyCode}`,
      shipping_total: `${this.humanPrice_(
        shipping_total,
        currencyCode
      )} ${currencyCode}`,
      total: `${this.humanPrice_(total, currencyCode)} ${currencyCode}`,
    }
  }

  async gcCreatedData({ id }) {
    const giftCard = await this.giftCardService_.retrieve(id, {
      relations: ['region', 'order'],
    })

    if (!giftCard.order) {
      return
    }

    const taxRate = giftCard.region.tax_rate / 100

    const locale = await this.extractLocale(order)

    return {
      ...giftCard,
      locale,
      email: giftCard.order.email,
      display_value: giftCard.value * (1 + taxRate),
    }
  }

  async returnRequestedData({ id, return_id }) {
    // Fetch the return request
    const returnRequest = await this.returnService_.retrieve(return_id, {
      relations: [
        'items',
        'items.item',
        'items.item.tax_lines',
        'items.item.variant',
        'items.item.variant.product',
        'shipping_method',
        'shipping_method.tax_lines',
        'shipping_method.shipping_option',
      ],
    })

    const items = await this.lineItemService_.list(
      {
        id: returnRequest.items.map(({ item_id }) => item_id),
      },
      { relations: ['tax_lines'] }
    )

    // Fetch the order
    const order = await this.orderService_.retrieve(id, {
      select: ['total'],
      relations: [
        'items',
        'items.tax_lines',
        'discounts',
        'discounts.rule',
        'shipping_address',
        'returns',
      ],
    })

    const currencyCode = order.currency_code.toUpperCase()

    // Calculate which items are in the return
    const returnItems = await Promise.all(
      returnRequest.items.map(async (i) => {
        const found = items.find((oi) => oi.id === i.item_id)
        found.quantity = i.quantity
        found.thumbnail = this.normalizeThumbUrl_(found.thumbnail)
        found.totals = await this.totalsService_.getLineItemTotals(
          found,
          order,
          {
            include_tax: true,
            use_tax_lines: true,
          }
        )
        found.price = `${this.humanPrice_(
          found.totals.total,
          currencyCode
        )} ${currencyCode}`
        found.tax_lines = found.totals.tax_lines
        return found
      })
    )

    // Get total of the returned products
    const item_subtotal = returnItems.reduce(
      (acc, next) => acc + next.totals.total,
      0
    )

    // If the return has a shipping method get the price and any attachments
    let shippingTotal = 0
    if (returnRequest.shipping_method) {
      const base = returnRequest.shipping_method.price
      shippingTotal =
        base +
        returnRequest.shipping_method.tax_lines.reduce((acc, next) => {
          return Math.round(acc + base * (next.rate / 100))
        }, 0)
    }

    const locale = await this.extractLocale(order)

    return {
      locale,
      has_shipping: !!returnRequest.shipping_method,
      email: order.email,
      items: returnItems,
      subtotal: `${this.humanPrice_(
        item_subtotal,
        currencyCode
      )} ${currencyCode}`,
      shipping_total: `${this.humanPrice_(
        shippingTotal,
        currencyCode
      )} ${currencyCode}`,
      refund_amount: `${this.humanPrice_(
        returnRequest.refund_amount,
        currencyCode
      )} ${currencyCode}`,
      return_request: {
        ...returnRequest,
        refund_amount: `${this.humanPrice_(
          returnRequest.refund_amount,
          currencyCode
        )} ${currencyCode}`,
      },
      order,
      date: returnRequest.updated_at.toDateString(),
    }
  }

  async swapReceivedData({ id }) {
    const store = await this.storeService_.retrieve()
    const swap = await this.swapService_.retrieve(id, {
      relations: [
        'additional_items',
        'additional_items.tax_lines',
        'return_order',
        'return_order.items',
        'return_order.items.item',
        'return_order.shipping_method',
        'return_order.shipping_method.shipping_option',
      ],
    })

    const returnRequest = swap.return_order

    const items = await this.lineItemService_.list(
      {
        id: returnRequest.items.map(({ item_id }) => item_id),
      },
      {
        relations: ['tax_lines'],
      }
    )

    returnRequest.items = returnRequest.items.map((item) => {
      const found = items.find((i) => i.id === item.item_id)
      return {
        ...item,
        item: found,
      }
    })

    const swapLink = store.swap_link_template.replace(
      /\{cart_id\}/,
      swap.cart_id
    )

    const order = await this.orderService_.retrieve(swap.order_id, {
      select: ['total'],
      relations: [
        'items',
        'discounts',
        'discounts.rule',
        'shipping_address',
        'swaps',
        'swaps.additional_items',
        'swaps.additional_items.tax_lines',
      ],
    })

    const cart = await this.cartService_.retrieve(swap.cart_id, {
      select: [
        'total',
        'tax_total',
        'discount_total',
        'shipping_total',
        'subtotal',
      ],
    })
    const currencyCode = order.currency_code.toUpperCase()

    const decoratedItems = await Promise.all(
      cart.items.map(async (i) => {
        const totals = await this.totalsService_.getLineItemTotals(i, cart, {
          include_tax: true,
        })

        return {
          ...i,
          totals,
          price: this.humanPrice_(
            totals.subtotal + totals.tax_total,
            currencyCode
          ),
        }
      })
    )

    const returnTotal = decoratedItems.reduce((acc, next) => {
      if (next.is_return) {
        return acc + -1 * (next.totals.subtotal + next.totals.tax_total)
      }
      return acc
    }, 0)

    const additionalTotal = decoratedItems.reduce((acc, next) => {
      if (!next.is_return) {
        return acc + next.totals.subtotal + next.totals.tax_total
      }
      return acc
    }, 0)

    const refundAmount = swap.return_order.refund_amount

    const locale = await this.extractLocale(order)

    return {
      locale,
      swap,
      order,
      return_request: returnRequest,
      date: swap.updated_at.toDateString(),
      swap_link: swapLink,
      email: order.email,
      items: decoratedItems.filter((di) => !di.is_return),
      return_items: decoratedItems.filter((di) => di.is_return),
      return_total: `${this.humanPrice_(
        returnTotal,
        currencyCode
      )} ${currencyCode}`,
      tax_total: `${this.humanPrice_(
        cart.total,
        currencyCode
      )} ${currencyCode}`,
      refund_amount: `${this.humanPrice_(
        refundAmount,
        currencyCode
      )} ${currencyCode}`,
      additional_total: `${this.humanPrice_(
        additionalTotal,
        currencyCode
      )} ${currencyCode}`,
    }
  }

  async swapCreatedData({ id }) {
    const store = await this.storeService_.retrieve()
    const swap = await this.swapService_.retrieve(id, {
      relations: [
        'additional_items',
        'additional_items.tax_lines',
        'return_order',
        'return_order.items',
        'return_order.items.item',
        'return_order.shipping_method',
        'return_order.shipping_method.shipping_option',
      ],
    })

    const returnRequest = swap.return_order

    const items = await this.lineItemService_.list(
      {
        id: returnRequest.items.map(({ item_id }) => item_id),
      },
      {
        relations: ['tax_lines'],
      }
    )

    returnRequest.items = returnRequest.items.map((item) => {
      const found = items.find((i) => i.id === item.item_id)
      return {
        ...item,
        item: found,
      }
    })

    const swapLink = store.swap_link_template.replace(
      /\{cart_id\}/,
      swap.cart_id
    )

    const order = await this.orderService_.retrieve(swap.order_id, {
      select: ['total'],
      relations: [
        'items',
        'items.tax_lines',
        'discounts',
        'discounts.rule',
        'shipping_address',
        'swaps',
        'swaps.additional_items',
        'swaps.additional_items.tax_lines',
      ],
    })

    const cart = await this.cartService_.retrieve(swap.cart_id, {
      select: [
        'total',
        'tax_total',
        'discount_total',
        'shipping_total',
        'subtotal',
      ],
    })
    const currencyCode = order.currency_code.toUpperCase()

    const decoratedItems = await Promise.all(
      cart.items.map(async (i) => {
        const totals = await this.totalsService_.getLineItemTotals(i, cart, {
          include_tax: true,
        })

        return {
          ...i,
          totals,
          tax_lines: totals.tax_lines,
          price: `${this.humanPrice_(
            totals.original_total / i.quantity,
            currencyCode
          )} ${currencyCode}`,
          discounted_price: `${this.humanPrice_(
            totals.total / i.quantity,
            currencyCode
          )} ${currencyCode}`,
        }
      })
    )

    const returnTotal = decoratedItems.reduce((acc, next) => {
      const { total } = next.totals
      if (next.is_return && next.variant_id) {
        return acc + -1 * total
      }
      return acc
    }, 0)

    const additionalTotal = decoratedItems.reduce((acc, next) => {
      const { total } = next.totals
      if (!next.is_return) {
        return acc + total
      }
      return acc
    }, 0)

    const refundAmount = swap.return_order.refund_amount

    const locale = await this.extractLocale(order)

    return {
      locale,
      swap,
      order,
      return_request: returnRequest,
      date: swap.updated_at.toDateString(),
      swap_link: swapLink,
      email: order.email,
      items: decoratedItems.filter((di) => !di.is_return),
      return_items: decoratedItems.filter((di) => di.is_return),
      return_total: `${this.humanPrice_(
        returnTotal,
        currencyCode
      )} ${currencyCode}`,
      refund_amount: `${this.humanPrice_(
        refundAmount,
        currencyCode
      )} ${currencyCode}`,
      additional_total: `${this.humanPrice_(
        additionalTotal,
        currencyCode
      )} ${currencyCode}`,
    }
  }

  async itemsReturnedData(data) {
    return this.returnRequestedData(data)
  }

  async swapShipmentCreatedData({ id, fulfillment_id }) {
    const swap = await this.swapService_.retrieve(id, {
      relations: [
        'shipping_address',
        'shipping_methods',
        'shipping_methods.tax_lines',
        'additional_items',
        'additional_items.tax_lines',
        'return_order',
        'return_order.items',
      ],
    })

    const order = await this.orderService_.retrieve(swap.order_id, {
      relations: [
        'region',
        'items',
        'items.tax_lines',
        'discounts',
        'discounts.rule',
        'swaps',
        'swaps.additional_items',
        'swaps.additional_items.tax_lines',
      ],
    })

    const cart = await this.cartService_.retrieve(swap.cart_id, {
      select: [
        'total',
        'tax_total',
        'discount_total',
        'shipping_total',
        'subtotal',
      ],
    })

    const returnRequest = swap.return_order
    const items = await this.lineItemService_.list(
      {
        id: returnRequest.items.map(({ item_id }) => item_id),
      },
      {
        relations: ['tax_lines'],
      }
    )

    const taxRate = order.tax_rate / 100
    const currencyCode = order.currency_code.toUpperCase()

    const returnItems = await Promise.all(
      swap.return_order.items.map(async (i) => {
        const found = items.find((oi) => oi.id === i.item_id)
        const totals = await this.totalsService_.getLineItemTotals(i, cart, {
          include_tax: true,
        })

        return {
          ...found,
          thumbnail: this.normalizeThumbUrl_(found.thumbnail),
          price: `${this.humanPrice_(
            totals.original_total / i.quantity,
            currencyCode
          )} ${currencyCode}`,
          discounted_price: `${this.humanPrice_(
            totals.total / i.quantity,
            currencyCode
          )} ${currencyCode}`,
          quantity: i.quantity,
        }
      })
    )

    const returnTotal = await this.totalsService_.getRefundTotal(
      order,
      returnItems
    )

    const constructedOrder = {
      ...order,
      shipping_methods: swap.shipping_methods,
      items: swap.additional_items,
    }

    const additionalTotal = await this.totalsService_.getTotal(constructedOrder)

    const refundAmount = swap.return_order.refund_amount

    const shipment = await this.fulfillmentService_.retrieve(fulfillment_id, {
      relations: ['tracking_links'],
    })

    const locale = await this.extractLocale(order)

    return {
      locale,
      swap,
      order,
      items: await Promise.all(
        swap.additional_items.map(async (i) => {
          const totals = await this.totalsService_.getLineItemTotals(i, cart, {
            include_tax: true,
          })

          return {
            ...i,
            thumbnail: this.normalizeThumbUrl_(i.thumbnail),
            price: `${this.humanPrice_(
              totals.original_total / i.quantity,
              currencyCode
            )} ${currencyCode}`,
            discounted_price: `${this.humanPrice_(
              totals.total / i.quantity,
              currencyCode
            )} ${currencyCode}`,
            quantity: i.quantity,
          }
        })
      ),
      date: swap.updated_at.toDateString(),
      email: order.email,
      tax_amount: `${this.humanPrice_(
        cart.tax_total,
        currencyCode
      )} ${currencyCode}`,
      paid_total: `${this.humanPrice_(
        swap.difference_due,
        currencyCode
      )} ${currencyCode}`,
      return_total: `${this.humanPrice_(
        returnTotal,
        currencyCode
      )} ${currencyCode}`,
      refund_amount: `${this.humanPrice_(
        refundAmount,
        currencyCode
      )} ${currencyCode}`,
      additional_total: `${this.humanPrice_(
        additionalTotal,
        currencyCode
      )} ${currencyCode}`,
      fulfillment: shipment,
      tracking_links: shipment.tracking_links,
      tracking_number: shipment.tracking_numbers.join(', '),
    }
  }

  async claimShipmentCreatedData({ id, fulfillment_id }) {
    const claim = await this.claimService_.retrieve(id, {
      relations: ['order', 'order.items', 'order.shipping_address'],
    })

    const shipment = await this.fulfillmentService_.retrieve(fulfillment_id, {
      relations: ['tracking_links'],
    })

    const locale = await this.extractLocale(claim.order)

    return {
      locale,
      email: claim.order.email,
      claim,
      order: claim.order,
      fulfillment: shipment,
      tracking_links: shipment.tracking_links,
      tracking_number: shipment.tracking_numbers.join(', '),
    }
  }

  async restockNotificationData({ variant_id, emails }) {
    const variant = await this.productVariantService_.retrieve(variant_id, {
      relations: ['product'],
    })

    let thumb
    if (variant.product.thumbnail) {
      thumb = this.normalizeThumbUrl_(variant.product.thumbnail)
    }

    return {
      product: {
        ...variant.product,
        thumbnail: thumb,
      },
      variant,
      variant_id,
      emails,
    }
  }

  userPasswordResetData(data) {
    return data
  }

  customerPasswordResetData(data) {
    return data
  }

  inviteData(data) {
    return { email: data.user_email, ...data }
  }

  processItems_(items, taxRate, currencyCode) {
    return items.map((i) => {
      return {
        ...i,
        thumbnail: this.normalizeThumbUrl_(i.thumbnail),
        price: `${this.humanPrice_(
          i.unit_price * (1 + taxRate),
          currencyCode
        )} ${currencyCode}`,
      }
    })
  }

  humanPrice_(amount, currency) {
    if (!amount) {
      return '0.00'
    }

    const normalized = humanizeAmount(amount, currency)
    return normalized.toFixed(
      zeroDecimalCurrencies.includes(currency.toLowerCase()) ? 0 : 2
    )
  }

  normalizeThumbUrl_(url) {
    if (!url) {
      return null
    }

    if (url.startsWith('http')) {
      return url
    } else if (url.startsWith('//')) {
      return `https:${url}`
    }
    return url
  }

  async extractLocale(fromOrder) {
    if (fromOrder.cart_id) {
      try {
        const cart = await this.cartService_.retrieve(fromOrder.cart_id, {
          select: ['id', 'context'],
        })

        if (cart.context && cart.context.locale) {
          return cart.context.locale
        }
      } catch (err) {
        console.log(err)
        console.warn('Failed to gather context for order')
        return null
      }
    }
    return null
  }
}

export default SmtpService
