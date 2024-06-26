
class UserSubscriber {
  constructor({ smtpService, eventBusService }) {
    this.smtpService_ = smtpService

    this.eventBus_ = eventBusService

    this.eventBus_.subscribe("customer.password_reset", async (data) => {
      await this.smtpService_.sendNotification(
        "customer.password_reset",
        {
          ...data, payload:
            Buffer.from(JSON.stringify({ email: payload.email, token: payload.token })).toString('base64')
        },
        null
      )
    })
  }
}

export default UserSubscriber
