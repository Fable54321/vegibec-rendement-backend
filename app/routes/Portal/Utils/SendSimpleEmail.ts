import { sendEmail } from "../../Visitors/Utils/testSMTP";



const sendSimpleEmail = async (to: string, subject: string, text: string) => {
    try {
        await sendEmail({
            to,
            subject,
            text,
        });
        return true;
    } catch (error) {
        console.error("Error sending email:", error);
        return false;
    }
}