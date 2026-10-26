import { useState } from "react";
import * as Yup from "yup";
import { Formik, Form } from "formik";
import { useDispatch } from "react-redux";
import FormField from "./FormField";
import Spinner from "./Spinner";
import { useAuthRequest } from "./authRequest";
import { authActions } from "../store/authSlice";
import { reconnectSocket } from "../hooks/useSocket";
import { IconText } from "./TaxiIcon";

const schema = Yup.object().shape({
  username: Yup.string().required("Обязательное поле"),
  password: Yup.string().required("Обязательное поле"),
});

const Login = ({ setUserWantsToLogin }) => {
  const dispatch = useDispatch();
  const [formError, setFormError] = useState(null);
  const { state, run } = useAuthRequest();

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
          onSubmit={async (values) => {
            setFormError(null);
            try {
              await run("/api/user/login", values);
              dispatch(authActions.login());
              // The socket must reconnect with the fresh auth cookie to join city rooms
              reconnectSocket();
            } catch (error) {
              setFormError(error.message ?? "Не удалось войти");
            }
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
                center
                persistentLabel
                labelName="Логин"
                labelClassName="bg-[#171717]"
                name="username"
                required
                value={values.username}
                error={errors.username}
              />

              <FormField
                center
                persistentLabel
                labelName="Пароль"
                labelClassName="bg-[#171717]"
                name="password"
                required
                value={values.password}
                error={errors.password}
                fieldType="password"
              />

              <button
                className={`press btn-accent mt-[0.5rem] p-[1.2rem] rounded-2xl font-display font-extrabold text-[1.5rem] w-full flex items-center justify-center tracking-wide ${
                  errors.username || errors.password ? "opacity-60" : ""
                }`}
                type="submit"
                disabled={state === "loading"}
                aria-busy={state === "loading"}
              >
                {state !== "loading" && <IconText>🚪 Войти</IconText>}
                {state === "loading" && <Spinner className="w-[2.5rem] h-[2.5rem]" />}
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
};

export default Login;
