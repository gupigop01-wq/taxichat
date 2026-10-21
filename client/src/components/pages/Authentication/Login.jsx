import React from "react";
import * as Yup from "yup";
import { Formik, Form } from "formik";
import FormField from "../../globals/FormField";
import useFetch from "../../../hooks/useFetch";
import { useDispatch } from "react-redux";
import { authActions } from "../../../store/authSlice";
import { reconnectSocket } from "../../../hooks/useSocket";
import Spinner from "../../globals/Spinner";
import { IconText } from "../../../taxi/TaxiIcon";

const schema = Yup.object().shape({
  username: Yup.string().required("Обязательное поле"),
  password: Yup.string().required("Обязательное поле"),
});

function Login({ setUserWantsToLogin }) {
  const dispatch = useDispatch();
  const [formError, setFormError] = React.useState(null);
  const { reqState, reqFn: loginRequest } = useFetch(
    { url: "/user/login", method: "POST" },
    () => {
      dispatch(authActions.login());
      // The socket must reconnect with the fresh auth cookie to join city rooms
      reconnectSocket();
    },
    (error) => setFormError(error?.message ?? "Не удалось войти")
  );

  return (
    <div className="w-full max-w-[34rem] mx-auto px-4 anim-rise">
      <div className="flex flex-col items-center gap-1 mb-6">
        <span className="brand-title brand-gradient">Бомбила</span>
        <span className="text-[1.2rem] text-secondary-text tracking-wide">такси без посредников</span>
      </div>

      <div className="glass-strong rounded-3xl p-5 space-y-4">
         <div className="text-center font-display font-bold text-[1.6rem]"><IconText>🚕 Вход</IconText></div>

        <Formik
          initialValues={{ username: "", password: "" }}
          validationSchema={schema}
          onSubmit={async (values, helpers) => {
            setFormError(null);
            await loginRequest(values, helpers);
          }}
        >
          {({ errors, values }) => (
            <Form className="flex flex-col gap-[1.4rem]" autoComplete="off">
              {formError && (
                <div role="alert" className="text-[1.3rem] text-danger text-center bg-danger/10 border border-danger/40 rounded-xl py-2 px-3">
                  {formError}
                </div>
              )}
              <FormField
                center={true}
                persistentLabel
                labelName="Логин"
                labelClassName="bg-[#171717]"
                name="username"
                required={true}
                value={values.username}
                error={errors.username}
              />

              <FormField
                center={true}
                persistentLabel
                labelName="Пароль"
                labelClassName="bg-[#171717]"
                name="password"
                required={true}
                value={values.password}
                error={errors.password}
                fieldType="password"
              />

              <button
                className={`press btn-accent mt-[0.5rem] p-[1.2rem] rounded-2xl font-display font-extrabold text-[1.5rem] w-full flex items-center justify-center tracking-wide ${
                  errors.username || errors.password ? "opacity-60" : ""
                }`}
                type="submit"
                disabled={reqState === "loading"}
                aria-busy={reqState === "loading"}
              >
                 {reqState !== "loading" && <IconText>🚪 Войти</IconText>}
                {reqState === "loading" && (
                  <Spinner className="w-[2.5rem] h-[2.5rem]" />
                )}
              </button>
            </Form>
          )}
        </Formik>
      </div>

      <button
        onClick={() => setUserWantsToLogin(false)}
        className="mt-[2rem] w-full text-center text-secondary-text underline hover:text-cta-icon text-[1.4rem]"
      >
        Ещё не с нами? Зарегистрироваться
      </button>
    </div>
  );
}

export default Login;
